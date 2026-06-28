/**
 * index.ts
 * -------------------------------------------------------------------------------------------------
 * AudienceSync CLI entrypoint.
 *
 * Subcommands:
 *   sync       Run a one-shot extract → hash → upload pass for a time window.
 *   schedule   Run the same pass on a cron schedule (long-lived process for containers / PM2).
 *   config     Print the resolved, secret-redacted configuration and exit.
 *
 * Configuration is read entirely from environment variables (12-factor). No secret is ever written
 * to disk, and no customer PII is logged. dotenv loads a local `.env` for development convenience.
 * -------------------------------------------------------------------------------------------------
 */

import process from 'node:process';

import { Command, Option } from 'commander';
import 'dotenv/config';
import cron from 'node-cron';

import { extractCustomers } from './extractor.js';
import { hashCustomers } from './normalizer.js';
import { syncToDestinations } from './sync.js';
import type { AppConfig, SourceConfig, SyncRunResult, SyncWindow } from './types.js';

/* ============================================================================================== *
 * Logging — timestamped, structured, PII-free.
 * ============================================================================================== */

function ts(): string {
  return new Date().toISOString();
}

function info(msg: string): void {
  process.stdout.write(`${ts()} [info]  ${msg}\n`);
}

function warn(msg: string): void {
  process.stderr.write(`${ts()} [warn]  ${msg}\n`);
}

function error(msg: string): void {
  process.stderr.write(`${ts()} [error] ${msg}\n`);
}

/* ============================================================================================== *
 * Environment parsing helpers.
 * ============================================================================================== */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? fallback : value;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/* ============================================================================================== *
 * Source resolution.
 * ============================================================================================== */

const DEFAULT_PG_QUERY = `
  SELECT id, email, phone, first_name, last_name, country, zip
  FROM customers
  WHERE last_purchase_at >= $1 AND last_purchase_at < $2
`;

const DEFAULT_MYSQL_QUERY = `
  SELECT id, email, phone, first_name, last_name, country, zip
  FROM customers
  WHERE last_purchase_at >= ? AND last_purchase_at < ?
`;

function resolveSource(): SourceConfig {
  const kind = optionalEnv('SOURCE_KIND', 'postgres').toLowerCase();

  switch (kind) {
    case 'postgres':
      return {
        kind: 'postgres',
        connectionString: requireEnv('PG_CONNECTION_STRING'),
        query: optionalEnv('SOURCE_QUERY', DEFAULT_PG_QUERY),
        ssl: envBool('PG_SSL', true),
      };
    case 'mysql':
      return {
        kind: 'mysql',
        connectionString: requireEnv('MYSQL_CONNECTION_STRING'),
        query: optionalEnv('SOURCE_QUERY', DEFAULT_MYSQL_QUERY),
        ssl: envBool('MYSQL_SSL', true),
      };
    case 'stripe': {
      const mode = optionalEnv('STRIPE_MODE', 'charges').toLowerCase();
      return {
        kind: 'stripe',
        apiKey: requireEnv('STRIPE_API_KEY'),
        mode: mode === 'customers' ? 'customers' : 'charges',
      };
    }
    default:
      throw new Error(`Unknown SOURCE_KIND "${kind}" (expected postgres | mysql | stripe)`);
  }
}

/* ============================================================================================== *
 * Full configuration resolution.
 * ============================================================================================== */

function resolveConfig(overrides: { dryRun?: boolean }): AppConfig {
  const source = resolveSource();

  const metaEnabled = envBool('META_ENABLED', false);
  const googleEnabled = envBool('GOOGLE_ENABLED', false);

  if (!metaEnabled && !googleEnabled) {
    throw new Error('No destination enabled. Set META_ENABLED=true and/or GOOGLE_ENABLED=true.');
  }

  if (googleEnabled) {
    const hasStatic = (process.env['GOOGLE_ACCESS_TOKEN'] ?? '').trim().length > 0;
    const hasRefresh =
      (process.env['GOOGLE_REFRESH_TOKEN'] ?? '').trim().length > 0 &&
      (process.env['GOOGLE_CLIENT_ID'] ?? '').trim().length > 0 &&
      (process.env['GOOGLE_CLIENT_SECRET'] ?? '').trim().length > 0;
    if (!hasStatic && !hasRefresh) {
      throw new Error(
        'Google enabled but no usable credentials. Provide GOOGLE_ACCESS_TOKEN, or ' +
          'GOOGLE_REFRESH_TOKEN + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (recommended for cron).',
      );
    }
  }

  const config: AppConfig = {
    source,
    lookbackHours: envInt('LOOKBACK_HOURS', 24),
    cronSchedule: optionalEnv('CRON_SCHEDULE', '0 2 * * *'),
    cronTimezone: optionalEnv('CRON_TIMEZONE', 'UTC'),
    dryRun: overrides.dryRun ?? envBool('DRY_RUN', false),
    maxRetries: envInt('MAX_RETRIES', 4),
    retryBaseDelayMs: envInt('RETRY_BASE_DELAY_MS', 500),
    destinations: {
      meta: {
        enabled: metaEnabled,
        accessToken: metaEnabled ? requireEnv('META_ACCESS_TOKEN') : '',
        audienceId: metaEnabled ? requireEnv('META_AUDIENCE_ID') : '',
        apiVersion: optionalEnv('META_API_VERSION', 'v21.0'),
        batchSize: envInt('META_BATCH_SIZE', 1000),
      },
      google: {
        enabled: googleEnabled,
        developerToken: googleEnabled ? requireEnv('GOOGLE_DEVELOPER_TOKEN') : '',
        // Either a static access token OR refresh-token credentials must be present (validated
        // below). For unattended cron, prefer the refresh-token path — access tokens expire hourly.
        accessToken: optionalEnv('GOOGLE_ACCESS_TOKEN', ''),
        ...(process.env['GOOGLE_REFRESH_TOKEN'] !== undefined
          ? { refreshToken: process.env['GOOGLE_REFRESH_TOKEN'] }
          : {}),
        ...(process.env['GOOGLE_CLIENT_ID'] !== undefined
          ? { clientId: process.env['GOOGLE_CLIENT_ID'] }
          : {}),
        ...(process.env['GOOGLE_CLIENT_SECRET'] !== undefined
          ? { clientSecret: process.env['GOOGLE_CLIENT_SECRET'] }
          : {}),
        userListResourceName: googleEnabled ? requireEnv('GOOGLE_USER_LIST_RESOURCE_NAME') : '',
        customerId: googleEnabled ? requireEnv('GOOGLE_CUSTOMER_ID') : '',
        ...(process.env['GOOGLE_LOGIN_CUSTOMER_ID'] !== undefined
          ? { loginCustomerId: process.env['GOOGLE_LOGIN_CUSTOMER_ID'] }
          : {}),
        apiVersion: optionalEnv('GOOGLE_API_VERSION', 'v17'),
        batchSize: envInt('GOOGLE_BATCH_SIZE', 1000),
      },
    },
  };

  return config;
}

/* ============================================================================================== *
 * Window computation.
 * ============================================================================================== */

/**
 * Compute the extraction window. When `--since`/`--until` are not given, the window is the last
 * `lookbackHours` ending now (e.g. 24h ⇒ "yesterday → now").
 */
function resolveWindow(config: AppConfig, opts: { since?: string; until?: string }): SyncWindow {
  const until = opts.until !== undefined ? new Date(opts.until) : new Date();
  if (Number.isNaN(until.getTime())) {
    throw new Error(`Invalid --until date: ${opts.until}`);
  }

  let since: Date;
  if (opts.since !== undefined) {
    since = new Date(opts.since);
    if (Number.isNaN(since.getTime())) {
      throw new Error(`Invalid --since date: ${opts.since}`);
    }
  } else {
    since = new Date(until.getTime() - config.lookbackHours * 60 * 60 * 1000);
  }

  if (since.getTime() >= until.getTime()) {
    throw new Error(
      `Window is empty: since (${since.toISOString()}) >= until (${until.toISOString()})`,
    );
  }

  return { since, until };
}

/* ============================================================================================== *
 * The core run — extract → hash → sync.
 * ============================================================================================== */

async function runSync(config: AppConfig, window: SyncWindow): Promise<SyncRunResult> {
  const startedAt = new Date();
  info(
    `Starting sync — window ${window.since.toISOString()} → ${window.until.toISOString()} ` +
      `(source=${config.source.kind}, dryRun=${config.dryRun})`,
  );

  // 1) Extract (in-memory).
  const raws = await extractCustomers(config.source, window);
  info(`Extracted ${raws.length} raw customer record(s)`);

  // 2) Normalize + hash (in-memory, synchronous, pure).
  const hashed = hashCustomers(raws);
  info(`Hashed ${hashed.length} record(s) (${raws.length - hashed.length} dropped as unmatchable)`);

  // 3) Upload to destinations.
  let results;
  if (hashed.length === 0) {
    warn('No hashable records — skipping upload.');
    results = [
      {
        platform: 'meta' as const,
        enabled: config.destinations.meta.enabled,
        batchesSent: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        skipped: true,
      },
      {
        platform: 'google' as const,
        enabled: config.destinations.google.enabled,
        batchesSent: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        skipped: true,
      },
    ];
  } else {
    results = await syncToDestinations(hashed, config, info);
  }

  const finishedAt = new Date();
  const result: SyncRunResult = {
    startedAt,
    finishedAt,
    window,
    extractedCount: raws.length,
    hashedCount: hashed.length,
    results,
    dryRun: config.dryRun,
  };

  // Summary line per platform.
  for (const r of result.results) {
    if (r.skipped && !r.enabled) {
      info(`[${r.platform}] disabled — skipped`);
    } else if (r.error !== undefined) {
      error(`[${r.platform}] FAILED — ${r.error}`);
    } else {
      info(
        `[${r.platform}] done — batches=${r.batchesSent} accepted=${r.recordsAccepted} ` +
          `rejected=${r.recordsRejected}`,
      );
    }
  }

  const durationMs = finishedAt.getTime() - startedAt.getTime();
  info(`Sync complete in ${durationMs}ms`);
  return result;
}

/** True if any enabled platform reported an error. */
function runHadFailure(result: SyncRunResult): boolean {
  return result.results.some((r) => r.error !== undefined);
}

/* ============================================================================================== *
 * Secret-redacted config printer.
 * ============================================================================================== */

function redact(value: string): string {
  if (value.length === 0) {
    return '(unset)';
  }
  if (value.length <= 6) {
    return '***';
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function printConfig(config: AppConfig): void {
  const safe = {
    source:
      config.source.kind === 'stripe'
        ? { kind: 'stripe', mode: config.source.mode, apiKey: redact(config.source.apiKey) }
        : {
            kind: config.source.kind,
            connectionString: redact(config.source.connectionString),
            ssl: config.source.ssl,
            query: config.source.query.trim().split('\n')[0]?.trim() ?? '',
          },
    lookbackHours: config.lookbackHours,
    cronSchedule: config.cronSchedule,
    cronTimezone: config.cronTimezone,
    dryRun: config.dryRun,
    maxRetries: config.maxRetries,
    retryBaseDelayMs: config.retryBaseDelayMs,
    destinations: {
      meta: {
        enabled: config.destinations.meta.enabled,
        audienceId: config.destinations.meta.audienceId,
        apiVersion: config.destinations.meta.apiVersion,
        batchSize: config.destinations.meta.batchSize,
        accessToken: redact(config.destinations.meta.accessToken),
      },
      google: {
        enabled: config.destinations.google.enabled,
        userListResourceName: config.destinations.google.userListResourceName,
        customerId: config.destinations.google.customerId,
        loginCustomerId: config.destinations.google.loginCustomerId ?? '(unset)',
        apiVersion: config.destinations.google.apiVersion,
        batchSize: config.destinations.google.batchSize,
        developerToken: redact(config.destinations.google.developerToken),
        accessToken: redact(config.destinations.google.accessToken),
      },
    },
  };
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
}

/* ============================================================================================== *
 * CLI wiring (commander).
 * ============================================================================================== */

const program = new Command();

program
  .name('audiencesync')
  .description(
    'Secure, in-memory Reverse ETL: extract high-value customers, SHA-256 hash their PII, and ' +
      'sync to Meta Custom Audiences + Google Customer Match. No CSV files, ever.',
  )
  .version('1.0.0');

program
  .command('sync')
  .description('Run a one-shot extract → hash → upload for a time window.')
  .option('--since <iso>', 'Inclusive lower bound (ISO 8601). Defaults to now - LOOKBACK_HOURS.')
  .option('--until <iso>', 'Exclusive upper bound (ISO 8601). Defaults to now.')
  .addOption(new Option('--dry-run', 'Extract + hash but do not upload.').default(false))
  .action(async (opts: { since?: string; until?: string; dryRun: boolean }) => {
    try {
      const config = resolveConfig({ dryRun: opts.dryRun });
      const window = resolveWindow(config, opts);
      const result = await runSync(config, window);
      process.exitCode = runHadFailure(result) ? 1 : 0;
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('schedule')
  .description('Run sync repeatedly on CRON_SCHEDULE (long-lived process).')
  .addOption(new Option('--dry-run', 'Extract + hash but do not upload.').default(false))
  .action((opts: { dryRun: boolean }) => {
    let config: AppConfig;
    try {
      config = resolveConfig({ dryRun: opts.dryRun });
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    if (!cron.validate(config.cronSchedule)) {
      error(`Invalid CRON_SCHEDULE: "${config.cronSchedule}"`);
      process.exitCode = 1;
      return;
    }

    info(
      `Scheduler started — cron="${config.cronSchedule}" tz=${config.cronTimezone} ` +
        `lookback=${config.lookbackHours}h. Press Ctrl+C to stop.`,
    );

    let running = false;
    const tick = async (): Promise<void> => {
      if (running) {
        warn('Previous run still in progress — skipping this tick.');
        return;
      }
      running = true;
      try {
        const window = resolveWindow(config, {});
        await runSync(config, window);
      } catch (err: unknown) {
        error(err instanceof Error ? err.message : String(err));
      } finally {
        running = false;
      }
    };

    // cron's callback signature is void-returning; fire-and-forget the async tick explicitly.
    const task = cron.schedule(config.cronSchedule, () => void tick(), {
      timezone: config.cronTimezone,
    });

    const shutdown = (signal: string): void => {
      info(`Received ${signal} — stopping scheduler.`);
      task.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });

program
  .command('config')
  .description('Print the resolved, secret-redacted configuration and exit.')
  .action(() => {
    try {
      const config = resolveConfig({});
      printConfig(config);
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// Guard against unhandled rejections leaking stack traces with potential context.
process.on('unhandledRejection', (reason: unknown) => {
  error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exitCode = 1;
});

program.parseAsync(process.argv).catch((err: unknown) => {
  error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

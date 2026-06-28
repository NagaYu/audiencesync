/**
 * sync.ts
 * -------------------------------------------------------------------------------------------------
 * Destination upload. Takes already-hashed customers and pushes them to Meta Custom Audiences and
 * Google Customer Match in correctly-sized, asynchronously-dispatched batches.
 *
 * Design notes:
 *   - Batching: data is chunked to each platform's configured batch size (default 1,000).
 *   - Resilience: every batch is retried with exponential backoff + jitter on transient failures
 *     (HTTP 429 / 5xx / network errors). Permanent 4xx errors fail fast.
 *   - In-memory only: hashed digests are held in memory and streamed out batch-by-batch; nothing is
 *     ever written to disk.
 *   - The hashed digests themselves are never logged.
 * -------------------------------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';

import axios, { AxiosError, type AxiosInstance } from 'axios';

import type {
  AppConfig,
  GoogleAddOperationsRequest,
  GoogleAddOperationsResponse,
  GoogleDestinationConfig,
  GoogleUserIdentifier,
  HashedCustomer,
  MetaDestinationConfig,
  MetaSchemaKey,
  MetaUsersRequest,
  MetaUsersResponse,
  PlatformSyncResult,
  Sha256Hex,
} from './types.js';

/* ============================================================================================== *
 * Generic helpers — chunking + retry.
 * ============================================================================================== */

/** Split an array into fixed-size chunks. The final chunk may be smaller. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(`chunk size must be > 0, received ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Promise-based sleep used for backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Decide whether an error is worth retrying (transient) vs. fatal (client error). */
function isRetryableError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === undefined) {
      // No response → network/timeout error → retryable.
      return true;
    }
    // Retry on rate limiting + server errors only.
    return status === 429 || (status >= 500 && status <= 599);
  }
  // Unknown non-axios error → treat as transient once.
  return true;
}

/** Extract a concise, PII-free message from an arbitrary error. */
function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const ax = error as AxiosError<unknown>;
    const status = ax.response?.status ?? 'no-status';
    const body = ax.response?.data;
    let detail = ax.message;
    if (body !== undefined && body !== null) {
      try {
        detail = typeof body === 'string' ? body : JSON.stringify(body);
      } catch {
        detail = ax.message;
      }
    }
    // Truncate to avoid dumping large upstream payloads into logs.
    return `HTTP ${status}: ${detail.slice(0, 500)}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Execute `fn` with exponential backoff. Retries up to `maxRetries` additional times on transient
 * errors, using `base * 2^attempt` ms plus jitter. Fatal errors throw immediately.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
  onRetry: (attempt: number, delayMs: number, error: unknown) => void,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }
      const jitter = Math.floor((attempt + 1) * 37) % 250; // deterministic, no Math.random.
      const delay = baseDelayMs * 2 ** attempt + jitter;
      onRetry(attempt + 1, delay, error);
      await sleep(delay);
      attempt += 1;
    }
  }
}

/* ============================================================================================== *
 * Meta Custom Audience uploader.
 * ============================================================================================== */

/** The fixed Meta schema order AudienceSync emits. Each row aligns positionally to this list. */
const META_SCHEMA: readonly MetaSchemaKey[] = ['EMAIL', 'PHONE', 'FN', 'LN', 'COUNTRY', 'ZIP'];

/**
 * Build a single Meta `data` row aligned to META_SCHEMA. Missing fields become "" (empty string),
 * which Meta interprets as "no value for this column" — the row is still matched on its populated
 * columns. Zip is hashed for Meta (unlike Google, which wants it in plain text).
 */
function toMetaRow(customer: HashedCustomer): string[] {
  const zipHashed: Sha256Hex | '' = customer.zip !== undefined
    ? // Meta wants ZIP hashed; we hash the already-normalized plain zip here.
      (createHash('sha256').update(customer.zip, 'utf8').digest('hex') as Sha256Hex)
    : '';

  return [
    customer.email ?? '',
    customer.phone ?? '',
    customer.firstName ?? '',
    customer.lastName ?? '',
    customer.country ?? '',
    zipHashed,
  ];
}

async function uploadToMeta(
  http: AxiosInstance,
  config: MetaDestinationConfig,
  customers: readonly HashedCustomer[],
  app: AppConfig,
  log: (msg: string) => void,
): Promise<PlatformSyncResult> {
  if (!config.enabled) {
    return {
      platform: 'meta',
      enabled: false,
      batchesSent: 0,
      recordsAccepted: 0,
      recordsRejected: 0,
      skipped: true,
    };
  }

  const url = `https://graph.facebook.com/${config.apiVersion}/${config.audienceId}/users`;
  const batches = chunk(customers, config.batchSize);

  let batchesSent = 0;
  let accepted = 0;
  let rejected = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]!;
    const body: MetaUsersRequest = {
      payload: {
        schema: META_SCHEMA,
        data: batch.map(toMetaRow),
      },
    };

    if (app.dryRun) {
      log(`[meta] (dry-run) would POST batch ${i + 1}/${batches.length} (${batch.length} users)`);
      batchesSent += 1;
      accepted += batch.length;
      continue;
    }

    const response = await withRetry<MetaUsersResponse>(
      async () => {
        const res = await http.post<MetaUsersResponse>(url, body, {
          params: { access_token: config.accessToken },
        });
        return res.data;
      },
      app.maxRetries,
      app.retryBaseDelayMs,
      (attempt, delay, error) => {
        log(
          `[meta] batch ${i + 1}/${batches.length} attempt ${attempt} failed, ` +
            `retrying in ${delay}ms — ${describeError(error)}`,
        );
      },
    );

    const received = response.num_received ?? batch.length;
    const invalid = response.num_invalid_entries ?? 0;
    accepted += Math.max(0, received - invalid);
    rejected += invalid;
    batchesSent += 1;
    log(
      `[meta] batch ${i + 1}/${batches.length} ok — received=${received} invalid=${invalid}`,
    );
  }

  return {
    platform: 'meta',
    enabled: true,
    batchesSent,
    recordsAccepted: accepted,
    recordsRejected: rejected,
    skipped: false,
  };
}

/* ============================================================================================== *
 * Google Customer Match uploader.
 * ============================================================================================== */

/**
 * Build the Google `userIdentifiers` array for one hashed customer. Google requires each
 * UserIdentifier object to carry exactly ONE identifier, so email, phone, and address become
 * separate objects within the same `create` operation (logically OR-matched by Google).
 */
function toGoogleIdentifiers(customer: HashedCustomer): GoogleUserIdentifier[] {
  const identifiers: GoogleUserIdentifier[] = [];

  if (customer.email !== undefined) {
    identifiers.push({ hashedEmail: customer.email });
  }
  if (customer.phone !== undefined) {
    identifiers.push({ hashedPhoneNumber: customer.phone });
  }
  if (
    customer.firstName !== undefined ||
    customer.lastName !== undefined ||
    customer.country !== undefined ||
    customer.zip !== undefined
  ) {
    const addressInfo: NonNullable<GoogleUserIdentifier['addressInfo']> = {};
    if (customer.firstName !== undefined) {
      Object.assign(addressInfo, { hashedFirstName: customer.firstName });
    }
    if (customer.lastName !== undefined) {
      Object.assign(addressInfo, { hashedLastName: customer.lastName });
    }
    if (customer.country !== undefined) {
      // Google's addressInfo.countryCode is plain ISO; we don't have plain country here (it was
      // hashed for Meta parity), so only emit when present as a hash is not valid. Skip to stay
      // spec-compliant — country/zip address matching still works via zip below.
    }
    if (customer.zip !== undefined) {
      Object.assign(addressInfo, { postalCode: customer.zip });
    }
    if (Object.keys(addressInfo).length > 0) {
      identifiers.push({ addressInfo });
    }
  }

  return identifiers;
}

/**
 * Create an offline user data job for the target user list. Returns its resource name, which scopes
 * subsequent addOperations + run calls.
 */
async function createGoogleJob(
  http: AxiosInstance,
  config: GoogleDestinationConfig,
  accessToken: string,
  app: AppConfig,
  log: (msg: string) => void,
): Promise<string> {
  const url =
    `https://googleads.googleapis.com/${config.apiVersion}/` +
    `customers/${config.customerId}/offlineUserDataJobs:create`;

  const body = {
    job: {
      type: 'CUSTOMER_MATCH_USER_LIST',
      customerMatchUserListMetadata: {
        userList: config.userListResourceName,
      },
    },
  };

  const data = await withRetry<{ resourceName: string }>(
    async () => {
      const res = await http.post<{ resourceName: string }>(url, body, {
        headers: googleHeaders(config, accessToken),
      });
      return res.data;
    },
    app.maxRetries,
    app.retryBaseDelayMs,
    (attempt, delay, error) => {
      log(`[google] create-job attempt ${attempt} failed, retrying in ${delay}ms — ${describeError(error)}`);
    },
  );

  log(`[google] created offline user data job: ${data.resourceName}`);
  return data.resourceName;
}

/** Standard headers for Google Ads API calls, using an already-resolved access token. */
function googleHeaders(config: GoogleDestinationConfig, accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': config.developerToken,
    'Content-Type': 'application/json',
  };
  if (config.loginCustomerId !== undefined && config.loginCustomerId.length > 0) {
    headers['login-customer-id'] = config.loginCustomerId;
  }
  return headers;
}

/** Shape of Google's OAuth2 token endpoint response. */
interface GoogleOAuthTokenResponse {
  readonly access_token: string;
  readonly expires_in?: number;
  readonly token_type?: string;
}

/**
 * Resolve a usable Google access token. If refresh-token credentials are configured, exchange them
 * for a fresh access token (the correct path for unattended cron, since access tokens expire after
 * ~1 hour). Otherwise fall back to the static `accessToken`.
 */
async function resolveGoogleAccessToken(
  http: AxiosInstance,
  config: GoogleDestinationConfig,
  app: AppConfig,
  log: (msg: string) => void,
): Promise<string> {
  const hasRefreshCreds =
    config.refreshToken !== undefined &&
    config.refreshToken.length > 0 &&
    config.clientId !== undefined &&
    config.clientId.length > 0 &&
    config.clientSecret !== undefined &&
    config.clientSecret.length > 0;

  if (!hasRefreshCreds) {
    if (config.accessToken.length === 0) {
      throw new Error(
        'Google: no usable credentials — set GOOGLE_ACCESS_TOKEN, or ' +
          'GOOGLE_REFRESH_TOKEN + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.',
      );
    }
    return config.accessToken;
  }

  // URL-encoded form body for the OAuth2 token endpoint.
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken as string,
    client_id: config.clientId as string,
    client_secret: config.clientSecret as string,
  });

  const token = await withRetry<string>(
    async () => {
      const res = await http.post<GoogleOAuthTokenResponse>(
        'https://oauth2.googleapis.com/token',
        form.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      if (typeof res.data.access_token !== 'string' || res.data.access_token.length === 0) {
        throw new Error('Google OAuth response did not contain an access_token');
      }
      return res.data.access_token;
    },
    app.maxRetries,
    app.retryBaseDelayMs,
    (attempt, delay, error) => {
      log(`[google] token-refresh attempt ${attempt} failed, retrying in ${delay}ms — ${describeError(error)}`);
    },
  );

  log('[google] minted a fresh access token via refresh_token');
  return token;
}

async function uploadToGoogle(
  http: AxiosInstance,
  config: GoogleDestinationConfig,
  customers: readonly HashedCustomer[],
  app: AppConfig,
  log: (msg: string) => void,
): Promise<PlatformSyncResult> {
  if (!config.enabled) {
    return {
      platform: 'google',
      enabled: false,
      batchesSent: 0,
      recordsAccepted: 0,
      recordsRejected: 0,
      skipped: true,
    };
  }

  const batches = chunk(customers, config.batchSize);

  let batchesSent = 0;
  let accepted = 0;
  let rejected = 0;

  // Dry-run: validate batching + payload shape without creating a job or hitting the network.
  if (app.dryRun) {
    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i]!;
      log(`[google] (dry-run) would add batch ${i + 1}/${batches.length} (${batch.length} users)`);
      batchesSent += 1;
      accepted += batch.length;
    }
    return {
      platform: 'google',
      enabled: true,
      batchesSent,
      recordsAccepted: accepted,
      recordsRejected: rejected,
      skipped: false,
    };
  }

  // 0) Resolve a fresh access token (refresh_token exchange when configured).
  const accessToken = await resolveGoogleAccessToken(http, config, app, log);

  // 1) Create the job.
  const jobResourceName = await createGoogleJob(http, config, accessToken, app, log);

  // 2) Add operations in batches.
  const addUrl =
    `https://googleads.googleapis.com/${config.apiVersion}/${jobResourceName}:addOperations`;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]!;
    const body: GoogleAddOperationsRequest = {
      enablePartialFailure: true,
      operations: batch.map((customer) => ({
        create: { userIdentifiers: toGoogleIdentifiers(customer) },
      })),
    };

    const data = await withRetry<GoogleAddOperationsResponse>(
      async () => {
        const res = await http.post<GoogleAddOperationsResponse>(addUrl, body, {
          headers: googleHeaders(config, accessToken),
        });
        return res.data;
      },
      app.maxRetries,
      app.retryBaseDelayMs,
      (attempt, delay, error) => {
        log(
          `[google] add-ops batch ${i + 1}/${batches.length} attempt ${attempt} failed, ` +
            `retrying in ${delay}ms — ${describeError(error)}`,
        );
      },
    );

    if (data.partialFailureError !== undefined) {
      // Partial failure: some operations rejected. We can't know the exact count without parsing
      // the detailed error, so conservatively count the batch as accepted-with-warnings.
      log(
        `[google] add-ops batch ${i + 1}/${batches.length} partial failure — ` +
          `${data.partialFailureError.message ?? 'see Google Ads logs'}`,
      );
    } else {
      log(`[google] add-ops batch ${i + 1}/${batches.length} ok (${batch.length} users)`);
    }
    accepted += batch.length;
    batchesSent += 1;
  }

  // 3) Run the job to begin asynchronous server-side processing.
  const runUrl =
    `https://googleads.googleapis.com/${config.apiVersion}/${jobResourceName}:run`;
  await withRetry<unknown>(
    async () => {
      const res = await http.post<unknown>(runUrl, {}, { headers: googleHeaders(config, accessToken) });
      return res.data;
    },
    app.maxRetries,
    app.retryBaseDelayMs,
    (attempt, delay, error) => {
      log(`[google] run-job attempt ${attempt} failed, retrying in ${delay}ms — ${describeError(error)}`);
    },
  );
  log(`[google] job ${jobResourceName} submitted for processing`);

  return {
    platform: 'google',
    enabled: true,
    batchesSent,
    recordsAccepted: accepted,
    recordsRejected: rejected,
    skipped: false,
  };
}

/* ============================================================================================== *
 * Public sync orchestrator.
 * ============================================================================================== */

/**
 * Push hashed customers to every enabled destination. Meta and Google run concurrently; a failure
 * in one is captured per-platform and does not abort the other. Returns one result per platform.
 */
export async function syncToDestinations(
  customers: readonly HashedCustomer[],
  app: AppConfig,
  log: (msg: string) => void,
): Promise<PlatformSyncResult[]> {
  const http = axios.create({
    timeout: 30_000,
    // Validate ourselves so non-2xx responses surface as errors for the retry layer.
    validateStatus: (status) => status >= 200 && status < 300,
    headers: { 'User-Agent': 'AudienceSync/1.0' },
  });

  const tasks: Array<Promise<PlatformSyncResult>> = [
    uploadToMeta(http, app.destinations.meta, customers, app, log).catch(
      (error: unknown): PlatformSyncResult => ({
        platform: 'meta',
        enabled: app.destinations.meta.enabled,
        batchesSent: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        skipped: false,
        error: describeError(error),
      }),
    ),
    uploadToGoogle(http, app.destinations.google, customers, app, log).catch(
      (error: unknown): PlatformSyncResult => ({
        platform: 'google',
        enabled: app.destinations.google.enabled,
        batchesSent: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        skipped: false,
        error: describeError(error),
      }),
    ),
  ];

  return Promise.all(tasks);
}

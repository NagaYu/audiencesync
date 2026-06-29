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
  GooglePartialFailureError,
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

/**
 * Count how many operations in a batch were rejected by a Google partial-failure error.
 *
 * Google packs per-operation errors into `partialFailureError.details[].errors[]`, each carrying a
 * `location.fieldPathElements` path like `[{ fieldName: "operations", index: N }, ...]`. We collect
 * the distinct `operations` indices (multiple errors can target the same operation) and return that
 * count, capped at `batchSize` for safety. Returns 0 when there is no partial failure.
 */
export function countFailedOperations(
  partialFailureError: GooglePartialFailureError | undefined,
  batchSize: number,
): number {
  if (partialFailureError?.details === undefined) {
    return 0;
  }
  const failedIndices = new Set<number>();
  for (const detail of partialFailureError.details) {
    for (const err of detail.errors ?? []) {
      for (const element of err.location?.fieldPathElements ?? []) {
        if (element.fieldName === 'operations' && typeof element.index === 'number') {
          failedIndices.add(element.index);
        }
      }
    }
  }
  return Math.min(failedIndices.size, batchSize);
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
  const zipHashed: Sha256Hex | '' =
    customer.zip !== undefined
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

/** Outcome of uploading a single batch: how many records the platform accepted vs. rejected. */
interface BatchOutcome {
  readonly accepted: number;
  readonly rejected: number;
}

/**
 * Upload one Meta batch (already sized to <= config.batchSize) to the Custom Audience. Retries
 * transient failures and reports the accepted/rejected split from Meta's response.
 */
async function sendMetaBatch(
  http: AxiosInstance,
  config: MetaDestinationConfig,
  batch: readonly HashedCustomer[],
  label: string,
  app: AppConfig,
  log: (msg: string) => void,
): Promise<BatchOutcome> {
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.audienceId}/users`;
  const body: MetaUsersRequest = {
    payload: {
      schema: META_SCHEMA,
      data: batch.map(toMetaRow),
    },
  };

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
        `[meta] ${label} attempt ${attempt} failed, retrying in ${delay}ms — ${describeError(error)}`,
      );
    },
  );

  const received = response.num_received ?? batch.length;
  const invalid = response.num_invalid_entries ?? 0;
  log(`[meta] ${label} ok — received=${received} invalid=${invalid}`);
  return { accepted: Math.max(0, received - invalid), rejected: invalid };
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
    customer.countryPlain !== undefined ||
    customer.zip !== undefined
  ) {
    const addressInfo: NonNullable<GoogleUserIdentifier['addressInfo']> = {};
    if (customer.firstName !== undefined) {
      Object.assign(addressInfo, { hashedFirstName: customer.firstName });
    }
    if (customer.lastName !== undefined) {
      Object.assign(addressInfo, { hashedLastName: customer.lastName });
    }
    if (customer.countryPlain !== undefined) {
      // Google's addressInfo.countryCode is plain-text ISO alpha-2 (NOT hashed). We carry the plain
      // value in `countryPlain` precisely so address matching includes the country.
      Object.assign(addressInfo, { countryCode: customer.countryPlain });
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
      log(
        `[google] create-job attempt ${attempt} failed, retrying in ${delay}ms — ${describeError(error)}`,
      );
    },
  );

  log(`[google] created offline user data job: ${data.resourceName}`);
  return data.resourceName;
}

/** Standard headers for Google Ads API calls, using an already-resolved access token. */
function googleHeaders(
  config: GoogleDestinationConfig,
  accessToken: string,
): Record<string, string> {
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
  // After the `hasRefreshCreds` guard above, TS narrows these three to non-undefined strings.
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
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
      log(
        `[google] token-refresh attempt ${attempt} failed, retrying in ${delay}ms — ${describeError(error)}`,
      );
    },
  );

  log('[google] minted a fresh access token via refresh_token');
  return token;
}

/**
 * Add one Google batch (already sized to <= config.batchSize) of operations to an existing offline
 * user data job. Retries transient failures and reports the accepted/rejected split parsed from any
 * partial-failure error.
 */
async function addGoogleOperations(
  http: AxiosInstance,
  config: GoogleDestinationConfig,
  accessToken: string,
  jobResourceName: string,
  batch: readonly HashedCustomer[],
  label: string,
  app: AppConfig,
  log: (msg: string) => void,
): Promise<BatchOutcome> {
  const addUrl = `https://googleads.googleapis.com/${config.apiVersion}/${jobResourceName}:addOperations`;
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
        `[google] ${label} attempt ${attempt} failed, retrying in ${delay}ms — ${describeError(error)}`,
      );
    },
  );

  if (data.partialFailureError !== undefined) {
    const failed = countFailedOperations(data.partialFailureError, batch.length);
    log(
      `[google] ${label} partial failure — ${failed}/${batch.length} rejected: ` +
        `${data.partialFailureError.message ?? 'see Google Ads logs'}`,
    );
    return { accepted: batch.length - failed, rejected: failed };
  }
  log(`[google] ${label} ok (${batch.length} users)`);
  return { accepted: batch.length, rejected: 0 };
}

/** Run an offline user data job to begin asynchronous server-side processing. */
async function runGoogleJob(
  http: AxiosInstance,
  config: GoogleDestinationConfig,
  accessToken: string,
  jobResourceName: string,
  app: AppConfig,
  log: (msg: string) => void,
): Promise<void> {
  const runUrl = `https://googleads.googleapis.com/${config.apiVersion}/${jobResourceName}:run`;
  await withRetry<unknown>(
    async () => {
      const res = await http.post<unknown>(
        runUrl,
        {},
        { headers: googleHeaders(config, accessToken) },
      );
      return res.data;
    },
    app.maxRetries,
    app.retryBaseDelayMs,
    (attempt, delay, error) => {
      log(
        `[google] run-job attempt ${attempt} failed, retrying in ${delay}ms — ${describeError(error)}`,
      );
    },
  );
  log(`[google] job ${jobResourceName} submitted for processing`);
}

/* ============================================================================================== *
 * Public streaming sync session.
 * ============================================================================================== */

/** Mutable per-platform accumulator used while streaming batches through a session. */
interface PlatformState {
  batchesSent: number;
  accepted: number;
  rejected: number;
  failed: boolean;
  error: string | undefined;
}

function newPlatformState(): PlatformState {
  return { batchesSent: 0, accepted: 0, rejected: 0, failed: false, error: undefined };
}

/**
 * A streaming upload session. Feed it hashed batches as they are produced from the source stream;
 * each batch is fanned out to every enabled destination (further sub-chunked to each platform's own
 * limit). Google's offline job is created lazily on the first batch and run on {@link finalize}.
 *
 * A failure in one platform is captured and stops further sends to that platform only — the other
 * keeps going, and the source stream is never aborted.
 */
export interface SyncSession {
  /** Upload one hashed batch to all enabled destinations. */
  send(batch: readonly HashedCustomer[]): Promise<void>;
  /** Finish the run (run the Google job) and return one result per platform. */
  finalize(): Promise<PlatformSyncResult[]>;
}

export function createSyncSession(app: AppConfig, log: (msg: string) => void): SyncSession {
  const http = axios.create({
    timeout: 30_000,
    // Validate ourselves so non-2xx responses surface as errors for the retry layer.
    validateStatus: (status) => status >= 200 && status < 300,
    headers: { 'User-Agent': 'AudienceSync/1.0' },
  });

  const meta = app.destinations.meta;
  const google = app.destinations.google;
  const metaState = newPlatformState();
  const googleState = newPlatformState();

  // Lazily-established Google job context (created on the first non-dry-run batch).
  let googleAccessToken: string | undefined;
  let googleJobResourceName: string | undefined;

  let metaBatchCounter = 0;
  let googleBatchCounter = 0;

  async function ensureGoogleJob(): Promise<void> {
    if (googleJobResourceName !== undefined) {
      return;
    }
    googleAccessToken = await resolveGoogleAccessToken(http, google, app, log);
    googleJobResourceName = await createGoogleJob(http, google, googleAccessToken, app, log);
  }

  async function sendToMeta(batch: readonly HashedCustomer[]): Promise<void> {
    if (!meta.enabled || metaState.failed) {
      return;
    }
    try {
      for (const sub of chunk(batch, meta.batchSize)) {
        metaBatchCounter += 1;
        const label = `batch #${metaBatchCounter}`;
        if (app.dryRun) {
          log(`[meta] (dry-run) would POST ${label} (${sub.length} users)`);
          metaState.accepted += sub.length;
        } else {
          const outcome = await sendMetaBatch(http, meta, sub, label, app, log);
          metaState.accepted += outcome.accepted;
          metaState.rejected += outcome.rejected;
        }
        metaState.batchesSent += 1;
      }
    } catch (error: unknown) {
      metaState.failed = true;
      metaState.error = describeError(error);
      log(`[meta] aborting after error — ${metaState.error}`);
    }
  }

  async function sendToGoogle(batch: readonly HashedCustomer[]): Promise<void> {
    if (!google.enabled || googleState.failed) {
      return;
    }
    try {
      if (!app.dryRun) {
        await ensureGoogleJob();
      }
      for (const sub of chunk(batch, google.batchSize)) {
        googleBatchCounter += 1;
        const label = `batch #${googleBatchCounter}`;
        if (app.dryRun) {
          log(`[google] (dry-run) would add ${label} (${sub.length} users)`);
          googleState.accepted += sub.length;
        } else {
          const outcome = await addGoogleOperations(
            http,
            google,
            googleAccessToken!,
            googleJobResourceName!,
            sub,
            label,
            app,
            log,
          );
          googleState.accepted += outcome.accepted;
          googleState.rejected += outcome.rejected;
        }
        googleState.batchesSent += 1;
      }
    } catch (error: unknown) {
      googleState.failed = true;
      googleState.error = describeError(error);
      log(`[google] aborting after error — ${googleState.error}`);
    }
  }

  function toResult(
    platform: 'meta' | 'google',
    enabled: boolean,
    state: PlatformState,
  ): PlatformSyncResult {
    if (!enabled) {
      return {
        platform,
        enabled: false,
        batchesSent: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        skipped: true,
      };
    }
    const base: PlatformSyncResult = {
      platform,
      enabled: true,
      batchesSent: state.batchesSent,
      recordsAccepted: state.accepted,
      recordsRejected: state.rejected,
      skipped: false,
    };
    return state.error !== undefined ? { ...base, error: state.error } : base;
  }

  return {
    async send(batch: readonly HashedCustomer[]): Promise<void> {
      if (batch.length === 0) {
        return;
      }
      // Fan out to both platforms concurrently; each captures its own errors.
      await Promise.all([sendToMeta(batch), sendToGoogle(batch)]);
    },

    async finalize(): Promise<PlatformSyncResult[]> {
      // Run the Google job iff it was created (i.e. at least one real batch was added) and healthy.
      if (
        google.enabled &&
        !googleState.failed &&
        !app.dryRun &&
        googleJobResourceName !== undefined &&
        googleAccessToken !== undefined
      ) {
        try {
          await runGoogleJob(http, google, googleAccessToken, googleJobResourceName, app, log);
        } catch (error: unknown) {
          googleState.failed = true;
          googleState.error = describeError(error);
        }
      }
      return [
        toResult('meta', meta.enabled, metaState),
        toResult('google', google.enabled, googleState),
      ];
    },
  };
}

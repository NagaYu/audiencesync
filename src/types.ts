/**
 * types.ts
 * -------------------------------------------------------------------------------------------------
 * Central, strict type definitions for AudienceSync.
 *
 * Every value that crosses a boundary (DB row, hashed payload, API request/response, config) has an
 * explicit shape here. No `any`. PII is modelled as a distinct branded type so that an un-hashed
 * value can never be accidentally placed where a hashed value is expected, and vice versa.
 * -------------------------------------------------------------------------------------------------
 */

/* ============================================================================================== *
 * Branded primitives — make it a compile error to mix raw PII with hashed PII.
 * ============================================================================================== */

declare const __brand: unique symbol;

/** A nominal "brand" applied to a base type so structurally-identical values cannot be swapped. */
export type Brand<TBase, TBrand extends string> = TBase & { readonly [__brand]: TBrand };

/** A raw, normalized-but-not-yet-hashed PII string (e.g. "jane@example.com"). */
export type NormalizedValue = Brand<string, 'NormalizedValue'>;

/** A lowercase hex SHA-256 digest of a normalized PII value. Exactly 64 hex chars. */
export type Sha256Hex = Brand<string, 'Sha256Hex'>;

/* ============================================================================================== *
 * Source-side customer model.
 * ============================================================================================== */

/**
 * A single raw customer record as extracted from a data source.
 * All fields are optional because different sources expose different identifiers; at least one of
 * `email` or `phone` must be present for the record to be usable (enforced at runtime, not type).
 */
export interface RawCustomer {
  /** Stable identifier from the source system, used only for logging/dedup — never sent upstream. */
  readonly id?: string | number | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  /** Optional given name; supported by Google Customer Match (hashed). */
  readonly firstName?: string | null;
  /** Optional family name; supported by Google Customer Match (hashed). */
  readonly lastName?: string | null;
  /** ISO 3166-1 alpha-2 country code, used for E.164 phone normalization fallback. */
  readonly country?: string | null;
  /** ISO 3166-1 alpha-2 country code, supported by Google Customer Match (NOT hashed). */
  readonly zip?: string | null;
}

/* ============================================================================================== *
 * Hashed payloads (what actually leaves the process).
 * ============================================================================================== */

/** A fully hashed identity record ready for upload. Only SHA-256 digests, never raw PII. */
export interface HashedCustomer {
  readonly email?: Sha256Hex;
  readonly phone?: Sha256Hex;
  readonly firstName?: Sha256Hex;
  readonly lastName?: Sha256Hex;
  /** Hashed ISO alpha-2 country, used by Meta (which hashes the COUNTRY column). */
  readonly country?: Sha256Hex;
  /**
   * Plain (un-hashed) ISO alpha-2 country. Google's `addressInfo.countryCode` must be plain text,
   * not hashed, so we keep both representations: `country` (hashed) for Meta, `countryPlain` for
   * Google. Country is not PII on its own, so retaining it in the clear is safe.
   */
  readonly countryPlain?: string;
  /** Google permits postal code in plain text (not hashed). Undefined when absent. */
  readonly zip?: string;
}

/* ============================================================================================== *
 * Platform identifiers.
 * ============================================================================================== */

export type Platform = 'meta' | 'google';

/* ---------------------------------------------------------------------------------------------- *
 * Meta Custom Audience — schema + payload shapes.
 * https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences
 * ---------------------------------------------------------------------------------------------- */

/** Meta's user-data schema keys (the order maps positionally to each `data` row). */
export type MetaSchemaKey = 'EMAIL' | 'PHONE' | 'FN' | 'LN' | 'COUNTRY' | 'ZIP';

/** A single Meta audience "users" replace/add request body. */
export interface MetaUsersPayload {
  readonly schema: readonly MetaSchemaKey[];
  /** Each inner array is one user, positionally aligned to `schema`. Values are SHA-256 hex. */
  readonly data: ReadonlyArray<ReadonlyArray<string>>;
}

/** Wrapper accepted by the `POST /{audience_id}/users` endpoint. */
export interface MetaUsersRequest {
  readonly payload: MetaUsersPayload;
}

/** Successful response from the Meta users endpoint. */
export interface MetaUsersResponse {
  readonly audience_id?: string;
  readonly session_id?: number;
  readonly num_received?: number;
  readonly num_invalid_entries?: number;
  readonly invalid_entry_samples?: Record<string, string>;
}

/* ---------------------------------------------------------------------------------------------- *
 * Google Customer Match — schema + payload shapes.
 * https://developers.google.com/google-ads/api/docs/remarketing/audience-types/customer-match
 * ---------------------------------------------------------------------------------------------- */

/** A Google `UserIdentifier` — exactly one identifier field is populated per object. */
export interface GoogleUserIdentifier {
  readonly hashedEmail?: Sha256Hex;
  readonly hashedPhoneNumber?: Sha256Hex;
  readonly addressInfo?: {
    readonly hashedFirstName?: Sha256Hex;
    readonly hashedLastName?: Sha256Hex;
    readonly countryCode?: string;
    readonly postalCode?: string;
  };
}

/** A single `create` operation within an `offlineUserDataJob:addOperations` request. */
export interface GoogleUserDataOperation {
  readonly create: {
    readonly userIdentifiers: readonly GoogleUserIdentifier[];
  };
}

/** Body of the `offlineUserDataJobs:addOperations` call. */
export interface GoogleAddOperationsRequest {
  readonly operations: readonly GoogleUserDataOperation[];
  readonly enablePartialFailure: boolean;
}

/** Response from `offlineUserDataJobs:addOperations`. */
export interface GoogleAddOperationsResponse {
  readonly partialFailureError?: {
    readonly code?: number;
    readonly message?: string;
  };
}

/** Response from creating an offline user data job. */
export interface GoogleCreateJobResponse {
  /** Resource name, e.g. "customers/123/offlineUserDataJobs/456". */
  readonly resourceName: string;
}

/* ============================================================================================== *
 * Extraction source configuration.
 * ============================================================================================== */

export type SourceKind = 'postgres' | 'mysql' | 'stripe';

export interface PostgresSourceConfig {
  readonly kind: 'postgres';
  readonly connectionString: string;
  /**
   * SQL returning rows shaped like `RawCustomer`. Must accept a single `$1` parameter bound to the
   * lower bound (inclusive) and `$2` bound to the upper bound (exclusive) of the extraction window.
   */
  readonly query: string;
  /** Optional TLS toggle. When true, `ssl: { rejectUnauthorized: true }` is used. */
  readonly ssl: boolean;
}

export interface MysqlSourceConfig {
  readonly kind: 'mysql';
  readonly connectionString: string;
  /** SQL returning rows shaped like `RawCustomer`, with two positional `?` placeholders. */
  readonly query: string;
  readonly ssl: boolean;
}

export interface StripeSourceConfig {
  readonly kind: 'stripe';
  readonly apiKey: string;
  /**
   * Which Stripe object drives the audience. `charges` (default) selects customers who were
   * charged in the window; `customers` selects customers created in the window.
   */
  readonly mode: 'charges' | 'customers';
}

export type SourceConfig = PostgresSourceConfig | MysqlSourceConfig | StripeSourceConfig;

/* ============================================================================================== *
 * Destination (platform) configuration.
 * ============================================================================================== */

export interface MetaDestinationConfig {
  readonly enabled: boolean;
  readonly accessToken: string;
  readonly audienceId: string;
  readonly apiVersion: string;
  /** Max users per `POST /{audience_id}/users` request. Meta caps at 10,000; default 1,000. */
  readonly batchSize: number;
}

export interface GoogleDestinationConfig {
  readonly enabled: boolean;
  readonly developerToken: string;
  /**
   * A pre-fetched OAuth2 access token. Optional when refresh-token credentials are supplied — in
   * that case a fresh access token is minted at run time (access tokens expire after ~1 hour, so
   * static tokens are unsuitable for unattended cron).
   */
  readonly accessToken: string;
  /** OAuth2 refresh token. When present (with clientId/clientSecret) a fresh access token is minted. */
  readonly refreshToken?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** The Customer Match user list resource name: "customers/{cid}/userLists/{id}". */
  readonly userListResourceName: string;
  /** Ads customer id (digits only) used in the request path. */
  readonly customerId: string;
  /** Login customer id for manager (MCC) accounts. Optional. */
  readonly loginCustomerId?: string;
  readonly apiVersion: string;
  /** Max user identifiers per addOperations request. Google allows up to 100k; default 1,000. */
  readonly batchSize: number;
}

export interface DestinationsConfig {
  readonly meta: MetaDestinationConfig;
  readonly google: GoogleDestinationConfig;
}

/* ============================================================================================== *
 * Runtime configuration & results.
 * ============================================================================================== */

export interface SyncWindow {
  /** Inclusive lower bound of the extraction window. */
  readonly since: Date;
  /** Exclusive upper bound of the extraction window. */
  readonly until: Date;
}

export interface AppConfig {
  readonly source: SourceConfig;
  readonly destinations: DestinationsConfig;
  /** Default lookback in hours when no explicit window is supplied (e.g. 24 = "yesterday"). */
  readonly lookbackHours: number;
  /** Cron expression for the scheduler subcommand. */
  readonly cronSchedule: string;
  /** IANA timezone for the scheduler. */
  readonly cronTimezone: string;
  /** When true, perform extraction + hashing but skip the network upload. */
  readonly dryRun: boolean;
  /** Max retry attempts for a failed batch upload. */
  readonly maxRetries: number;
  /** Base backoff in milliseconds for exponential retry. */
  readonly retryBaseDelayMs: number;
}

/** Per-platform outcome of a sync run. */
export interface PlatformSyncResult {
  readonly platform: Platform;
  readonly enabled: boolean;
  readonly batchesSent: number;
  readonly recordsAccepted: number;
  readonly recordsRejected: number;
  readonly skipped: boolean;
  readonly error?: string;
}

/** Aggregate outcome of a full sync run. */
export interface SyncRunResult {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly window: SyncWindow;
  readonly extractedCount: number;
  readonly hashedCount: number;
  readonly results: readonly PlatformSyncResult[];
  readonly dryRun: boolean;
}

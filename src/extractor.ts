/**
 * extractor.ts
 * -------------------------------------------------------------------------------------------------
 * Source extraction. Pulls raw customer rows for a time window from PostgreSQL, MySQL, or Stripe,
 * entirely in memory. No file is ever written.
 *
 * Each extractor:
 *   - Opens a short-lived connection scoped to the call.
 *   - Binds the extraction window via parameterized queries (no string interpolation → no SQLi).
 *   - Maps rows into the strict `RawCustomer` shape.
 *   - Guarantees the connection/pool is closed in a `finally`, even on error.
 * -------------------------------------------------------------------------------------------------
 */

import mysql from 'mysql2/promise';
import { Pool as PgPool } from 'pg';
import QueryStream from 'pg-query-stream';
import Stripe from 'stripe';

import type {
  MysqlSourceConfig,
  PostgresSourceConfig,
  RawCustomer,
  SourceConfig,
  StripeSourceConfig,
  SyncWindow,
} from './types.js';

/* ============================================================================================== *
 * Row coercion helpers — defensively map loosely-typed driver rows into RawCustomer.
 * ============================================================================================== */

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

/** Map an arbitrary driver row (object keyed by column name) into a RawCustomer. */
function rowToRawCustomer(row: Record<string, unknown>): RawCustomer {
  return {
    id: asNullableString(row['id'] ?? row['customer_id'] ?? null),
    email: asNullableString(row['email']),
    phone: asNullableString(row['phone'] ?? row['phone_number']),
    firstName: asNullableString(row['first_name'] ?? row['firstname'] ?? row['given_name']),
    lastName: asNullableString(row['last_name'] ?? row['lastname'] ?? row['family_name']),
    country: asNullableString(row['country'] ?? row['country_code']),
    zip: asNullableString(row['zip'] ?? row['postal_code'] ?? row['zip_code']),
  };
}

/* ============================================================================================== *
 * PostgreSQL extractor.
 * ============================================================================================== */

async function* streamFromPostgres(
  config: PostgresSourceConfig,
  window: SyncWindow,
): AsyncGenerator<RawCustomer> {
  const pool = new PgPool({
    connectionString: config.connectionString,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    // Defensive statement timeout so a runaway query cannot hang the cron job.
    statement_timeout: 60_000,
  });

  // A server-side cursor (pg-query-stream) fetches rows in pages of `batchSize` rather than
  // buffering the whole result set, keeping peak memory bounded regardless of row count.
  const client = await pool.connect();
  try {
    // `$1` = window.since (inclusive), `$2` = window.until (exclusive).
    const query = new QueryStream(
      config.query,
      [window.since.toISOString(), window.until.toISOString()],
      { batchSize: 1_000 },
    );
    const stream = client.query(query);
    for await (const row of stream as AsyncIterable<Record<string, unknown>>) {
      yield rowToRawCustomer(row);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

/* ============================================================================================== *
 * MySQL extractor.
 * ============================================================================================== */

/** Minimal shape of mysql2's callback query object, just enough to obtain a row stream. */
interface StreamableQuery {
  stream(options?: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
}

/** Minimal shape of mysql2's core (callback) connection used for row streaming. */
interface StreamableConnection {
  query(sql: string, values: unknown[]): StreamableQuery;
}

async function* streamFromMysql(
  config: MysqlSourceConfig,
  window: SyncWindow,
): AsyncGenerator<RawCustomer> {
  const pool = mysql.createPool({
    uri: config.connectionString,
    connectionLimit: 4,
    connectTimeout: 15_000,
    waitForConnections: true,
    // Return DATETIME/TIMESTAMP as strings to avoid implicit local-timezone coercion.
    dateStrings: true,
    // Only attach `ssl` when enabled — omitting the key entirely satisfies
    // exactOptionalPropertyTypes (passing `undefined` is rejected by mysql2's types).
    ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  const conn = await pool.getConnection();
  try {
    // Two positional `?` placeholders: lower bound (inclusive), upper bound (exclusive).
    const params = [
      window.since.toISOString().slice(0, 19).replace('T', ' '),
      window.until.toISOString().slice(0, 19).replace('T', ' '),
    ];
    // mysql2's row-streaming API lives on the underlying (callback) connection, which the promise
    // typings don't surface cleanly. Cast to a minimal streamable shape: `.query(...).stream()`
    // returns a Node Readable that emits one row at a time without buffering the whole result set.
    const core = conn.connection as unknown as StreamableConnection;
    const stream = core.query(config.query, params).stream();
    for await (const row of stream) {
      yield rowToRawCustomer(row);
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

/* ============================================================================================== *
 * Stripe extractor.
 * ============================================================================================== */

/**
 * Resolve a Stripe customer's identity fields (email/phone/name) for a given customer reference,
 * which may already be an expanded object or just an id string.
 */
async function resolveStripeCustomer(
  stripe: Stripe,
  customerRef: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  fallbackEmail: string | null,
): Promise<RawCustomer | null> {
  if (customerRef === null) {
    // No customer attached; fall back to the charge's billing email if present.
    if (fallbackEmail === null) {
      return null;
    }
    return { email: fallbackEmail };
  }

  // Already expanded and not deleted.
  if (typeof customerRef !== 'string') {
    if ('deleted' in customerRef && customerRef.deleted) {
      return fallbackEmail === null ? null : { email: fallbackEmail };
    }
    return stripeCustomerToRaw(customerRef, fallbackEmail);
  }

  // Only an id — retrieve the full object.
  try {
    const cust = await stripe.customers.retrieve(customerRef);
    if (cust.deleted) {
      return fallbackEmail === null ? null : { email: fallbackEmail };
    }
    return stripeCustomerToRaw(cust, fallbackEmail);
  } catch {
    // If retrieval fails, fall back to the charge email rather than dropping the record outright.
    return fallbackEmail === null ? null : { email: fallbackEmail };
  }
}

/** Map a Stripe.Customer (plus optional fallback email) to RawCustomer. */
function stripeCustomerToRaw(cust: Stripe.Customer, fallbackEmail: string | null): RawCustomer {
  const address = cust.address ?? null;
  const fullName = cust.name ?? null;
  let firstName: string | null = null;
  let lastName: string | null = null;
  if (fullName !== null) {
    const parts = fullName.trim().split(/\s+/);
    firstName = parts[0] ?? null;
    lastName = parts.length > 1 ? (parts[parts.length - 1] ?? null) : null;
  }

  return {
    id: cust.id,
    email: cust.email ?? fallbackEmail,
    phone: cust.phone ?? null,
    firstName,
    lastName,
    country: address?.country ?? null,
    zip: address?.postal_code ?? null,
  };
}

async function* streamFromStripe(
  config: StripeSourceConfig,
  window: SyncWindow,
): AsyncGenerator<RawCustomer> {
  const stripe = new Stripe(config.apiKey, {
    apiVersion: '2024-06-20',
    maxNetworkRetries: 3,
    timeout: 30_000,
    telemetry: false,
  });

  const sinceUnix = Math.floor(window.since.getTime() / 1000);
  const untilUnix = Math.floor(window.until.getTime() / 1000);

  // Dedup by stable customer id so repeat purchasers are only synced once per run. This Set is the
  // single piece of unbounded state; it holds short id strings, not full records, so it stays small
  // relative to the row data even for large windows.
  const seen = new Set<string>();
  const isNew = (raw: RawCustomer): boolean => {
    const key = String(raw.id ?? raw.email ?? '');
    if (key.length === 0) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  };

  if (config.mode === 'customers') {
    // Customers created within the window. The Stripe SDK auto-paginates lazily.
    for await (const customer of stripe.customers.list({
      created: { gte: sinceUnix, lt: untilUnix },
      limit: 100,
    })) {
      if (customer.deleted) {
        continue;
      }
      const raw = stripeCustomerToRaw(customer, null);
      if (isNew(raw)) {
        yield raw;
      }
    }
    return;
  }

  // mode === 'charges' (default): customers who were successfully charged within the window.
  for await (const charge of stripe.charges.list({
    created: { gte: sinceUnix, lt: untilUnix },
    limit: 100,
    expand: ['data.customer'],
  })) {
    if (charge.paid !== true || charge.status !== 'succeeded') {
      continue;
    }
    const fallbackEmail = charge.billing_details?.email ?? charge.receipt_email ?? null;
    const raw = await resolveStripeCustomer(stripe, charge.customer, fallbackEmail);
    if (raw === null) {
      continue;
    }
    if (isNew(raw)) {
      yield raw;
    }
  }
}

/* ============================================================================================== *
 * Public dispatcher.
 * ============================================================================================== */

/**
 * Stream raw customers for the given window from whichever source is configured, one record at a
 * time. SQL sources use server-side cursors / row streaming and Stripe uses lazy pagination, so the
 * caller can process arbitrarily large audiences with bounded memory. Nothing touches disk.
 */
export function streamCustomers(
  source: SourceConfig,
  window: SyncWindow,
): AsyncGenerator<RawCustomer> {
  switch (source.kind) {
    case 'postgres':
      return streamFromPostgres(source, window);
    case 'mysql':
      return streamFromMysql(source, window);
    case 'stripe':
      return streamFromStripe(source, window);
    default: {
      // Exhaustiveness guard — a new SourceKind without a branch is a compile error.
      const _never: never = source;
      throw new Error(`Unsupported source kind: ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * Group an async iterable into arrays of at most `size` items. The final group may be smaller. This
 * lets a streaming source be processed in bounded-memory batches without ever materializing the
 * whole stream.
 */
export async function* batchAsync<T>(source: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  if (size <= 0) {
    throw new Error(`batch size must be > 0, received ${size}`);
  }
  let buffer: T[] = [];
  for await (const item of source) {
    buffer.push(item);
    if (buffer.length >= size) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}

/**
 * Convenience wrapper that fully drains {@link streamCustomers} into an array. Prefer the streaming
 * API for large audiences; this exists for callers and tests that want the whole set at once.
 */
export async function extractCustomers(
  source: SourceConfig,
  window: SyncWindow,
): Promise<RawCustomer[]> {
  const out: RawCustomer[] = [];
  for await (const raw of streamCustomers(source, window)) {
    out.push(raw);
  }
  return out;
}

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

async function extractFromPostgres(
  config: PostgresSourceConfig,
  window: SyncWindow,
): Promise<RawCustomer[]> {
  const pool = new PgPool({
    connectionString: config.connectionString,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    // Defensive statement timeout so a runaway query cannot hang the cron job.
    statement_timeout: 60_000,
  });

  try {
    // `$1` = window.since (inclusive), `$2` = window.until (exclusive).
    const result = await pool.query<Record<string, unknown>>(config.query, [
      window.since.toISOString(),
      window.until.toISOString(),
    ]);
    return result.rows.map(rowToRawCustomer);
  } finally {
    await pool.end();
  }
}

/* ============================================================================================== *
 * MySQL extractor.
 * ============================================================================================== */

async function extractFromMysql(
  config: MysqlSourceConfig,
  window: SyncWindow,
): Promise<RawCustomer[]> {
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

  try {
    // Two positional `?` placeholders: lower bound (inclusive), upper bound (exclusive).
    const [rows] = await pool.query(config.query, [
      window.since.toISOString().slice(0, 19).replace('T', ' '),
      window.until.toISOString().slice(0, 19).replace('T', ' '),
    ]);

    if (!Array.isArray(rows)) {
      return [];
    }
    return (rows as Record<string, unknown>[]).map(rowToRawCustomer);
  } finally {
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

async function extractFromStripe(
  config: StripeSourceConfig,
  window: SyncWindow,
): Promise<RawCustomer[]> {
  const stripe = new Stripe(config.apiKey, {
    apiVersion: '2024-06-20',
    maxNetworkRetries: 3,
    timeout: 30_000,
    telemetry: false,
  });

  const sinceUnix = Math.floor(window.since.getTime() / 1000);
  const untilUnix = Math.floor(window.until.getTime() / 1000);

  const out: RawCustomer[] = [];
  // Dedup by stable customer id so repeat purchasers are only synced once per run.
  const seen = new Set<string>();

  if (config.mode === 'customers') {
    // Customers created within the window.
    for await (const customer of stripe.customers.list({
      created: { gte: sinceUnix, lt: untilUnix },
      limit: 100,
    })) {
      if (customer.deleted) {
        continue;
      }
      const raw = stripeCustomerToRaw(customer, null);
      const key = String(raw.id ?? raw.email ?? '');
      if (key.length > 0 && seen.has(key)) {
        continue;
      }
      if (key.length > 0) {
        seen.add(key);
      }
      out.push(raw);
    }
    return out;
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
    const key = String(raw.id ?? raw.email ?? '');
    if (key.length > 0 && seen.has(key)) {
      continue;
    }
    if (key.length > 0) {
      seen.add(key);
    }
    out.push(raw);
  }

  return out;
}

/* ============================================================================================== *
 * Public dispatcher.
 * ============================================================================================== */

/**
 * Extract raw customers for the given window from whichever source is configured. The result is an
 * in-memory array; nothing is persisted to disk at any point.
 */
export async function extractCustomers(
  source: SourceConfig,
  window: SyncWindow,
): Promise<RawCustomer[]> {
  switch (source.kind) {
    case 'postgres':
      return extractFromPostgres(source, window);
    case 'mysql':
      return extractFromMysql(source, window);
    case 'stripe':
      return extractFromStripe(source, window);
    default: {
      // Exhaustiveness guard — a new SourceKind without a branch is a compile error.
      const _never: never = source;
      throw new Error(`Unsupported source kind: ${JSON.stringify(_never)}`);
    }
  }
}

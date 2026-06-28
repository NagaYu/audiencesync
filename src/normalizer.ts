/**
 * normalizer.ts
 * -------------------------------------------------------------------------------------------------
 * Pure, in-memory PII cleansing + SHA-256 hashing.
 *
 * Implements the normalization rules required by BOTH Meta (Custom Audiences) and Google
 * (Customer Match) so a single hashed digest is accepted by either platform:
 *
 *   Email  : trim → collapse internal whitespace away → lowercase → SHA-256(hex)
 *   Phone  : strip every non-digit → drop leading zeros / IDD prefixes → ensure E.164 country
 *            code → SHA-256(hex)
 *   Name   : trim → lowercase → strip leading/trailing punctuation → SHA-256(hex)
 *   Country: ISO-3166 alpha-2, uppercase → SHA-256(hex) for Meta / plain for Google addressInfo
 *   Zip    : trim → lowercase (US: first 5 digits) → NOT hashed (Google), hashed for Meta
 *
 * Nothing here touches disk or the network. Every function is synchronous and side-effect free.
 * -------------------------------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';

import type {
  HashedCustomer,
  NormalizedValue,
  RawCustomer,
  Sha256Hex,
} from './types.js';

/* ============================================================================================== *
 * Low-level helpers.
 * ============================================================================================== */

/**
 * Compute a lowercase hex SHA-256 digest of an already-normalized value.
 * The input is branded `NormalizedValue` to make it impossible to accidentally hash a raw,
 * un-normalized string at a call site.
 */
export function sha256Hex(value: NormalizedValue): Sha256Hex {
  return createHash('sha256').update(value, 'utf8').digest('hex') as Sha256Hex;
}

/** Treat empty / whitespace-only / nullish input as "no value". */
function isBlank(value: string | null | undefined): value is null | undefined | '' {
  return value === null || value === undefined || value.trim().length === 0;
}

/* ============================================================================================== *
 * Email normalization.
 * ============================================================================================== */

/**
 * Normalize an email address per Meta/Google rules:
 *   - Trim surrounding whitespace.
 *   - Remove ALL internal whitespace (defensive; valid addresses contain none).
 *   - Lowercase the entire address.
 *
 * Note: we deliberately do NOT strip Gmail dots or `+tag` suffixes. Both Meta and Google hash the
 * address exactly as the user typed it (minus case/whitespace), and altering it would lower the
 * match rate. Returns `undefined` when the value is blank or structurally not an email.
 */
export function normalizeEmail(raw: string | null | undefined): NormalizedValue | undefined {
  if (isBlank(raw)) {
    return undefined;
  }

  const cleaned = raw.replace(/\s+/g, '').toLowerCase();

  // Minimal structural guard: exactly one "@" with non-empty local and domain parts, and a dot in
  // the domain. This rejects obviously broken values without trying to fully validate RFC 5322.
  const atIndex = cleaned.indexOf('@');
  if (atIndex <= 0 || atIndex !== cleaned.lastIndexOf('@') || atIndex === cleaned.length - 1) {
    return undefined;
  }
  const domain = cleaned.slice(atIndex + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return undefined;
  }

  return cleaned as NormalizedValue;
}

/* ============================================================================================== *
 * Phone normalization (E.164).
 * ============================================================================================== */

/**
 * Default country calling codes for the ISO alpha-2 codes we most commonly see. Used to prepend a
 * country code to national-format numbers that lack one. Extend as needed for your customer base.
 */
const COUNTRY_CALLING_CODES: Readonly<Record<string, string>> = {
  US: '1',
  CA: '1',
  GB: '44',
  IE: '353',
  AU: '61',
  NZ: '64',
  DE: '49',
  FR: '33',
  ES: '34',
  IT: '39',
  NL: '31',
  BE: '32',
  CH: '41',
  AT: '43',
  SE: '46',
  NO: '47',
  DK: '45',
  FI: '358',
  PT: '351',
  PL: '48',
  JP: '81',
  KR: '82',
  CN: '86',
  HK: '852',
  TW: '886',
  SG: '65',
  IN: '91',
  BR: '55',
  MX: '52',
  AR: '54',
  ZA: '27',
  AE: '971',
};

/**
 * The fallback calling code applied when a national number has no country prefix and no per-record
 * country hint is supplied. Override via the `DEFAULT_COUNTRY` env var (ISO alpha-2).
 */
function defaultCountryCode(): string {
  const iso = (process.env['DEFAULT_COUNTRY'] ?? 'US').toUpperCase();
  return COUNTRY_CALLING_CODES[iso] ?? '1';
}

/**
 * Normalize a phone number to E.164 *digits only* (no leading "+", as required by Meta/Google
 * hashing). Steps:
 *   1. Detect an explicit international prefix ("+" or "00") before stripping.
 *   2. Strip every non-digit character.
 *   3. Drop a single leading "0" national trunk prefix when a country code will be prepended.
 *   4. Prepend the calling code derived from the explicit prefix, the per-record country, or the
 *      configured default.
 *
 * Returns `undefined` for values too short to be a real phone number.
 */
export function normalizePhone(
  raw: string | null | undefined,
  countryIso?: string | null,
): NormalizedValue | undefined {
  if (isBlank(raw)) {
    return undefined;
  }

  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith('+');
  const hadIddZeros = /^00\d/.test(trimmed.replace(/[^\d+]/g, ''));

  // Strip everything that is not a digit.
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) {
    return undefined;
  }

  if (hadPlus || hadIddZeros) {
    // The number already carries an international prefix.
    if (hadIddZeros) {
      digits = digits.replace(/^00/, '');
    }
    // `digits` now begins with the country code; nothing more to prepend.
  } else {
    // National format — derive and prepend a country code.
    const iso = (countryIso ?? '').toUpperCase();
    const callingCode = COUNTRY_CALLING_CODES[iso] ?? defaultCountryCode();

    // Drop a single national trunk "0" before prepending the country code.
    const national = digits.replace(/^0+/, '');
    if (national.length === 0) {
      return undefined;
    }
    digits = `${callingCode}${national}`;
  }

  // E.164 numbers are between 8 and 15 digits including the country code. Anything shorter than 8 is
  // almost certainly junk (extensions, partial entries) and would only pollute match rates.
  if (digits.length < 8 || digits.length > 15) {
    return undefined;
  }

  return digits as NormalizedValue;
}

/* ============================================================================================== *
 * Name / address normalization.
 * ============================================================================================== */

/** Lowercase, trim, and strip surrounding punctuation/whitespace from a personal name. */
export function normalizeName(raw: string | null | undefined): NormalizedValue | undefined {
  if (isBlank(raw)) {
    return undefined;
  }
  const cleaned = raw
    .trim()
    .toLowerCase()
    // Remove leading/trailing characters that are not letters (incl. accented) — keeps internal
    // hyphens/apostrophes for names like "o'neil" or "jean-luc".
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .replace(/\s+/g, ' ');

  return cleaned.length === 0 ? undefined : (cleaned as NormalizedValue);
}

/** Normalize an ISO 3166-1 alpha-2 country code to uppercase (e.g. "us" → "US"). */
export function normalizeCountry(raw: string | null | undefined): NormalizedValue | undefined {
  if (isBlank(raw)) {
    return undefined;
  }
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (cleaned.length !== 2) {
    return undefined;
  }
  return cleaned as NormalizedValue;
}

/**
 * Normalize a postal code. Google accepts postal codes in PLAIN TEXT (never hashed), so this
 * returns a normalized but un-hashed string. For US zips we keep the leading 5 digits.
 */
export function normalizeZip(
  raw: string | null | undefined,
  countryIso?: string | null,
): string | undefined {
  if (isBlank(raw)) {
    return undefined;
  }
  const iso = (countryIso ?? '').toUpperCase();
  let cleaned = raw.trim().toLowerCase().replace(/\s+/g, '');

  if (iso === 'US') {
    const fiveDigit = cleaned.replace(/\D/g, '').slice(0, 5);
    cleaned = fiveDigit;
  }

  return cleaned.length === 0 ? undefined : cleaned;
}

/* ============================================================================================== *
 * Record-level hashing.
 * ============================================================================================== */

/**
 * Convert a single raw customer into a fully hashed record. Returns `undefined` when neither a
 * usable email nor phone can be produced (such a record cannot be matched and is dropped).
 *
 * The function is total and pure: given identical input and `DEFAULT_COUNTRY`, it always yields the
 * identical output, and it never throws on malformed field values — bad fields are simply omitted.
 */
export function hashCustomer(raw: RawCustomer): HashedCustomer | undefined {
  const emailNorm = normalizeEmail(raw.email);
  const phoneNorm = normalizePhone(raw.phone, raw.country);

  // A record with no email and no phone is unmatchable upstream; drop it.
  if (emailNorm === undefined && phoneNorm === undefined) {
    return undefined;
  }

  const firstNorm = normalizeName(raw.firstName);
  const lastNorm = normalizeName(raw.lastName);
  const countryNorm = normalizeCountry(raw.country);
  const zipNorm = normalizeZip(raw.zip, raw.country);

  // Build immutably, only adding keys that have a value (respects exactOptionalPropertyTypes).
  const hashed: {
    -readonly [K in keyof HashedCustomer]: HashedCustomer[K];
  } = {};

  if (emailNorm !== undefined) {
    hashed.email = sha256Hex(emailNorm);
  }
  if (phoneNorm !== undefined) {
    hashed.phone = sha256Hex(phoneNorm);
  }
  if (firstNorm !== undefined) {
    hashed.firstName = sha256Hex(firstNorm);
  }
  if (lastNorm !== undefined) {
    hashed.lastName = sha256Hex(lastNorm);
  }
  if (countryNorm !== undefined) {
    // Meta wants the country hashed; Google wants it in plain text. Keep both.
    hashed.country = sha256Hex(countryNorm);
    hashed.countryPlain = countryNorm;
  }
  if (zipNorm !== undefined) {
    hashed.zip = zipNorm;
  }

  return hashed;
}

/**
 * Stream-friendly batch hashing. Maps an array of raw customers to hashed records, dropping any
 * that cannot be hashed. Pure and synchronous; safe to call on large in-memory arrays.
 */
export function hashCustomers(raws: readonly RawCustomer[]): HashedCustomer[] {
  const out: HashedCustomer[] = [];
  for (const raw of raws) {
    const hashed = hashCustomer(raw);
    if (hashed !== undefined) {
      out.push(hashed);
    }
  }
  return out;
}

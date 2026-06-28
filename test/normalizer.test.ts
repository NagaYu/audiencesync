import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  hashCustomer,
  normalizeCountry,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeZip,
  sha256Hex,
} from '../src/normalizer.js';
import type { NormalizedValue } from '../src/types.js';

/** Helper: independent reference SHA-256 hex used to assert against the module's output. */
function refHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('normalizeEmail', () => {
  it('trims, lowercases, and strips internal whitespace', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
    expect(normalizeEmail('jane doe@example.com')).toBe('janedoe@example.com');
  });

  it('preserves gmail dots and +tags (no aggressive canonicalization)', () => {
    expect(normalizeEmail('Jane.Doe+Promo@Gmail.com')).toBe('jane.doe+promo@gmail.com');
  });

  it('rejects structurally invalid addresses', () => {
    expect(normalizeEmail('')).toBeUndefined();
    expect(normalizeEmail('   ')).toBeUndefined();
    expect(normalizeEmail(null)).toBeUndefined();
    expect(normalizeEmail(undefined)).toBeUndefined();
    expect(normalizeEmail('not-an-email')).toBeUndefined();
    expect(normalizeEmail('@example.com')).toBeUndefined();
    expect(normalizeEmail('jane@')).toBeUndefined();
    expect(normalizeEmail('jane@example')).toBeUndefined();
    expect(normalizeEmail('a@@b.com')).toBeUndefined();
    expect(normalizeEmail('jane@.com')).toBeUndefined();
  });
});

describe('normalizePhone', () => {
  it('converts a US national number to E.164 digits (no plus)', () => {
    expect(normalizePhone('(415) 555-0132', 'US')).toBe('14155550132');
    expect(normalizePhone('415-555-0132', 'US')).toBe('14155550132');
  });

  it('drops a national trunk zero before prepending the country code', () => {
    // UK national "020 7946 0958" -> 44 20 7946 0958
    expect(normalizePhone('020 7946 0958', 'GB')).toBe('442079460958');
  });

  it('respects an explicit + international prefix', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('442079460958');
  });

  it('handles a 00 IDD prefix', () => {
    expect(normalizePhone('0044 20 7946 0958')).toBe('442079460958');
  });

  it('falls back to DEFAULT_COUNTRY when no country is given', () => {
    // Default is US (calling code 1) unless DEFAULT_COUNTRY overrides it.
    expect(normalizePhone('4155550132')).toBe('14155550132');
  });

  it('rejects junk / too-short values', () => {
    expect(normalizePhone('')).toBeUndefined();
    expect(normalizePhone('   ')).toBeUndefined();
    expect(normalizePhone(null)).toBeUndefined();
    expect(normalizePhone('abc')).toBeUndefined();
    expect(normalizePhone('123', 'US')).toBeUndefined(); // too short even after prefix
  });
});

describe('normalizeName', () => {
  it('lowercases, trims, and strips surrounding punctuation', () => {
    expect(normalizeName('  Jane!  ')).toBe('jane');
    expect(normalizeName('"Doe".')).toBe('doe');
  });

  it('keeps internal hyphens and apostrophes', () => {
    expect(normalizeName("O'Neil")).toBe("o'neil");
    expect(normalizeName('Jean-Luc')).toBe('jean-luc');
  });

  it('returns undefined for empty/blank', () => {
    expect(normalizeName('')).toBeUndefined();
    expect(normalizeName('   ')).toBeUndefined();
    expect(normalizeName('!!!')).toBeUndefined();
    expect(normalizeName(null)).toBeUndefined();
  });
});

describe('normalizeCountry', () => {
  it('uppercases a valid ISO alpha-2 code', () => {
    expect(normalizeCountry('us')).toBe('US');
    expect(normalizeCountry(' Gb ')).toBe('GB');
  });

  it('rejects non-2-letter values', () => {
    expect(normalizeCountry('usa')).toBeUndefined();
    expect(normalizeCountry('1')).toBeUndefined();
    expect(normalizeCountry('')).toBeUndefined();
  });
});

describe('normalizeZip', () => {
  it('reduces US zips to the first 5 digits', () => {
    expect(normalizeZip('94107-1234', 'US')).toBe('94107');
  });

  it('lowercases and strips whitespace for non-US zips', () => {
    expect(normalizeZip('SW1A 1AA', 'GB')).toBe('sw1a1aa');
  });

  it('returns undefined for blank', () => {
    expect(normalizeZip('', 'US')).toBeUndefined();
    expect(normalizeZip(null)).toBeUndefined();
  });
});

describe('sha256Hex', () => {
  it('produces a deterministic 64-char lowercase hex digest', () => {
    const value = 'jane.doe@example.com' as NormalizedValue;
    const digest = sha256Hex(value);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(refHash('jane.doe@example.com'));
  });
});

describe('hashCustomer', () => {
  it('hashes email + phone end-to-end against an independent reference', () => {
    const hashed = hashCustomer({
      email: '  Jane.Doe@Example.COM ',
      phone: '(415) 555-0132',
      country: 'US',
    });
    expect(hashed).toBeDefined();
    expect(hashed?.email).toBe(refHash('jane.doe@example.com'));
    expect(hashed?.phone).toBe(refHash('14155550132'));
    expect(hashed?.country).toBe(refHash('US'));
  });

  it('drops records with neither email nor phone', () => {
    expect(hashCustomer({ firstName: 'Jane' })).toBeUndefined();
    expect(hashCustomer({ email: 'not-an-email', phone: 'abc' })).toBeUndefined();
  });

  it('keeps a record matchable on phone alone', () => {
    const hashed = hashCustomer({ phone: '+44 20 7946 0958' });
    expect(hashed).toBeDefined();
    expect(hashed?.phone).toBe(refHash('442079460958'));
    expect(hashed?.email).toBeUndefined();
  });

  it('sends zip as plain text (Google requirement), not hashed', () => {
    const hashed = hashCustomer({ email: 'a@b.com', zip: '94107-1234', country: 'US' });
    expect(hashed?.zip).toBe('94107');
  });

  it('never leaks a raw value — all identity fields are 64-char hex', () => {
    const hashed = hashCustomer({
      email: 'a@b.com',
      phone: '4155550132',
      firstName: 'Jane',
      lastName: 'Doe',
    });
    for (const field of [hashed?.email, hashed?.phone, hashed?.firstName, hashed?.lastName]) {
      expect(field).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

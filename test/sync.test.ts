import { describe, expect, it } from 'vitest';

import { chunk, countFailedOperations } from '../src/sync.js';
import type { GooglePartialFailureError } from '../src/types.js';

describe('chunk', () => {
  it('splits into fixed-size chunks with a smaller final chunk', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single chunk when size >= length', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it('returns no chunks for an empty input', () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it('throws on a non-positive size', () => {
    expect(() => chunk([1], 0)).toThrow();
    expect(() => chunk([1], -1)).toThrow();
  });
});

describe('countFailedOperations', () => {
  it('returns 0 when there is no partial failure', () => {
    expect(countFailedOperations(undefined, 100)).toBe(0);
  });

  it('returns 0 when details are absent', () => {
    const err: GooglePartialFailureError = { code: 3, message: 'oops' };
    expect(countFailedOperations(err, 100)).toBe(0);
  });

  it('counts distinct rejected operation indices', () => {
    const err: GooglePartialFailureError = {
      message: 'partial failure',
      details: [
        {
          errors: [
            { location: { fieldPathElements: [{ fieldName: 'operations', index: 0 }] } },
            { location: { fieldPathElements: [{ fieldName: 'operations', index: 2 }] } },
          ],
        },
      ],
    };
    expect(countFailedOperations(err, 100)).toBe(2);
  });

  it('deduplicates multiple errors targeting the same operation', () => {
    const err: GooglePartialFailureError = {
      details: [
        {
          errors: [
            { location: { fieldPathElements: [{ fieldName: 'operations', index: 5 }] } },
            { location: { fieldPathElements: [{ fieldName: 'operations', index: 5 }] } },
          ],
        },
      ],
    };
    expect(countFailedOperations(err, 100)).toBe(1);
  });

  it('ignores field path elements that are not operation indices', () => {
    const err: GooglePartialFailureError = {
      details: [
        {
          errors: [
            {
              location: {
                fieldPathElements: [
                  { fieldName: 'operations', index: 1 },
                  { fieldName: 'create' },
                  { fieldName: 'user_identifiers', index: 0 },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(countFailedOperations(err, 100)).toBe(1);
  });

  it('caps the count at the batch size', () => {
    const err: GooglePartialFailureError = {
      details: [
        {
          errors: [
            { location: { fieldPathElements: [{ fieldName: 'operations', index: 0 }] } },
            { location: { fieldPathElements: [{ fieldName: 'operations', index: 1 }] } },
            { location: { fieldPathElements: [{ fieldName: 'operations', index: 2 }] } },
          ],
        },
      ],
    };
    expect(countFailedOperations(err, 2)).toBe(2);
  });
});

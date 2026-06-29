import { describe, expect, it } from 'vitest';

import { batchAsync } from '../src/extractor.js';

/** Build an async iterable yielding 0..n-1, recording how many items have been pulled so far. */
function counting(n: number): { iterable: AsyncIterable<number>; pulled: () => number } {
  let pulled = 0;
  async function* gen(): AsyncGenerator<number> {
    for (let i = 0; i < n; i += 1) {
      pulled += 1;
      yield i;
    }
  }
  return { iterable: gen(), pulled: () => pulled };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
  }
  return out;
}

describe('batchAsync', () => {
  it('groups an async stream into fixed-size batches', async () => {
    const { iterable } = counting(10);
    const batches = await collect(batchAsync(iterable, 3));
    expect(batches).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]);
  });

  it('emits a single full batch when size matches the stream length', async () => {
    const { iterable } = counting(4);
    const batches = await collect(batchAsync(iterable, 4));
    expect(batches).toEqual([[0, 1, 2, 3]]);
  });

  it('yields nothing for an empty stream', async () => {
    async function* empty(): AsyncGenerator<number> {
      // intentionally yields nothing
    }
    const batches = await collect(batchAsync(empty(), 5));
    expect(batches).toEqual([]);
  });

  it('rejects a non-positive batch size', async () => {
    async function* one(): AsyncGenerator<number> {
      yield 1;
    }
    await expect(collect(batchAsync(one(), 0))).rejects.toThrow(/batch size must be > 0/);
  });

  it('is lazy: never buffers more than one batch worth of items ahead', async () => {
    // Pull exactly one batch and stop. The source should not have been drained beyond what was
    // needed to fill (and detect the end of) that first batch — i.e. peak buffering is bounded.
    const { iterable, pulled } = counting(100);
    const gen = batchAsync(iterable, 10);
    const first = await gen.next();
    expect(first.value).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Only the 10 items of the first batch have been pulled; the remaining 90 stay un-evaluated.
    expect(pulled()).toBe(10);
  });
});

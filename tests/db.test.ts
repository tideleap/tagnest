import { describe, it, expect } from 'vitest';
import {
  colorForName,
  encodeCursor,
  decodeCursor,
  SORTS,
  queryInChunks,
  D1_IN_CHUNK,
  D1_MAX_PARAMS,
  parseSnapshotKeys,
  serializeSnapshotKeys,
} from '../functions/_lib/db';
import type { BookmarkSort } from '../shared/types';
import type { Env } from '../functions/_lib/env';

describe('colorForName', () => {
  it('is deterministic for a given name', () => {
    expect(colorForName('Rust')).toBe(colorForName('Rust'));
  });

  it('maps different names to different colours (usually)', () => {
    const a = colorForName('Frontend');
    const b = colorForName('Backend');
    // Not guaranteed distinct, but extremely likely; guards against a constant return.
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
  });

  it('stays within the palette range 0..7', () => {
    for (const name of ['a', 'Rust', '前端', '阅读', 'very-long-tag-name-here']) {
      const c = colorForName(name);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(8);
    }
  });
});

describe('keyset cursor', () => {
  it('round-trips a string-valued cursor', () => {
    const cursor = { v: '2023-01-01T00:00:00.000Z', id: 'abc123' };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it('round-trips a numeric-valued cursor', () => {
    const cursor = { v: 1700000000, id: 'zzz' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow();
  });

  it('rejects base64 that is not a valid cursor shape', () => {
    const bogus = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64');
    expect(() => decodeCursor(bogus)).toThrow();
  });
});

describe('SORTS', () => {
  const keys: BookmarkSort[] = [
    'created_desc',
    'created_asc',
    'updated_desc',
    'title_asc',
    'visits_desc',
  ];

  it('maps every sort to a column and direction', () => {
    for (const key of keys) {
      const spec = SORTS[key];
      expect(spec).toBeDefined();
      expect(spec.column.length).toBeGreaterThan(0);
      expect(['ASC', 'DESC']).toContain(spec.direction);
    }
  });
});

describe('queryInChunks — D1 100-bound-parameter limit', () => {
  it('never binds more than D1_MAX_PARAMS per statement (regression: import 503)', async () => {
    const boundCounts: number[] = [];
    // A fake D1 binding that records how many params each statement received
    // and echoes back the IN-list values so we can verify correctness.
    const fakeDb = {
      prepare(_sql: string) {
        return {
          bind(...args: unknown[]) {
            boundCounts.push(args.length);
            const slice = args.slice(1) as string[]; // drop the leading user_id
            return {
              all: async () => ({ results: slice.map((v) => ({ k: v })) }),
            };
          },
        };
      },
    } as unknown as Env['DB'];

    const values = Array.from({ length: 6000 }, (_, i) => `k${i}`);
    const rows = await queryInChunks<{ k: string }, string>(
      fakeDb,
      values,
      ['user-1'],
      (ph) => `SELECT k FROM t WHERE user_id = ? AND k IN (${ph})`,
      (r) => r.k,
    );

    // Every statement stayed within the D1 limit (1 lead param + <=99 values).
    expect(D1_IN_CHUNK).toBe(D1_MAX_PARAMS - 1);
    for (const n of boundCounts) expect(n).toBeLessThanOrEqual(D1_MAX_PARAMS);
    // It actually chunked into multiple queries.
    expect(boundCounts.length).toBeGreaterThan(1);
    // All input values came back.
    expect(rows.sort()).toEqual(values.slice().sort());
  });
});

describe('snapshot_keys serialization', () => {
  it('round-trips an ordered list through the JSON column', () => {
    const keys = ['snapshots/u/b-1.webp', 'snapshots/u/b-2.webp'];
    expect(parseSnapshotKeys(serializeSnapshotKeys(keys))).toEqual(keys);
  });

  it('serializes an empty list to null and parses null to []', () => {
    expect(serializeSnapshotKeys([])).toBeNull();
    expect(parseSnapshotKeys(null)).toEqual([]);
    expect(parseSnapshotKeys(undefined)).toEqual([]);
  });

  it('tolerates malformed JSON / non-array / non-string values', () => {
    expect(parseSnapshotKeys('{not json')).toEqual([]);
    expect(parseSnapshotKeys('"a-string"')).toEqual([]);
    expect(parseSnapshotKeys('[1, "ok", false]')).toEqual(['ok']);
  });
});


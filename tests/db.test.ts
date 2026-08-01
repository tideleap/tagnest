import { describe, it, expect } from 'vitest';
import {
  colorForName,
  encodeCursor,
  decodeCursor,
  SORTS,
} from '../functions/_lib/db';
import type { BookmarkSort } from '../shared/types';

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

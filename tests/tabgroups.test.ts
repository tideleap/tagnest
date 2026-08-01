import { describe, expect, it } from 'vitest';
import {
  computePositions,
  mapTabGroup,
  mapTabItem,
  normalizeColorIndex,
  POSITION_STEP,
  validateGroupName,
} from '../functions/_lib/tabgroups';
import { badRequest } from '../functions/_lib/http';

describe('validateGroupName', () => {
  it('trims and collapses whitespace', () => {
    expect(validateGroupName('  设计  参考  ')).toBe('设计 参考');
  });
  it('rejects empty / blank', () => {
    expect(() => validateGroupName('')).toThrow();
    expect(() => validateGroupName('   ')).toThrow();
    expect(() => validateGroupName(undefined)).toThrow();
  });
  it('rejects overly long names', () => {
    expect(() => validateGroupName('x'.repeat(61))).toThrow();
  });
  it('throws an ApiException with 400', () => {
    try {
      validateGroupName('');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(badRequest('').constructor);
      expect((e as { status: number }).status).toBe(400);
    }
  });
});

describe('normalizeColorIndex', () => {
  it('passes through valid 0-7', () => {
    expect(normalizeColorIndex(0)).toBe(0);
    expect(normalizeColorIndex(7)).toBe(7);
  });
  it('clamps out-of-range to 0', () => {
    expect(normalizeColorIndex(8)).toBe(0);
    expect(normalizeColorIndex(-1)).toBe(0);
    expect(normalizeColorIndex('9')).toBe(0);
  });
});

describe('computePositions', () => {
  it('assigns descending weights so the first id sorts first', () => {
    const ids = ['a', 'b', 'c'];
    const pos = computePositions(ids);
    expect(pos.get('a')).toBe(3 * POSITION_STEP);
    expect(pos.get('b')).toBe(2 * POSITION_STEP);
    expect(pos.get('c')).toBe(1 * POSITION_STEP);
  });
  it('is idempotent — same input yields same output', () => {
    const a = computePositions(['x', 'y']);
    const b = computePositions(['x', 'y']);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

describe('mappers', () => {
  it('mapTabGroup copies fields and defaults count to 0', () => {
    const g = mapTabGroup({ id: 'g1', name: '阅读', color_index: 2, sort_order: 1 });
    expect(g).toMatchObject({ id: 'g1', name: '阅读', colorIndex: 2, sortOrder: 1, count: 0 });
  });
  it('mapTabItem embeds a slim bookmark', () => {
    const it = mapTabItem({
      id: 'i1',
      group_id: 'g1',
      bookmark_id: 'b1',
      position: 1000,
      created_at: 't',
      url: 'https://e.com',
      title: 'E',
      favicon_url: 'https://e.com/f.ico',
    });
    expect(it.groupId).toBe('g1');
    expect(it.bookmark).toEqual({ id: 'b1', url: 'https://e.com', title: 'E', faviconUrl: 'https://e.com/f.ico' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_AUTO_CLEAR,
  DEFAULT_TAGS_AUTO_CLEAR,
  mapSettings,
  parseAutoClearDelay,
  parseRetentionLimit,
} from '../functions/api/settings';

describe('mapSettings (auto-clear + retention defaults)', () => {
  it('returns fully defaulted settings when no row exists', () => {
    const s = mapSettings(null);
    expect(s.snapshotRetentionLimit).toBe(5);
    expect(s.searchAutoClearEnabled).toBe(true);
    expect(s.searchAutoClearDelay).toBe(15);
    expect(s.tagsAutoClearEnabled).toBe(true);
    expect(s.tagsAutoClearDelay).toBe(30);
  });

  it('reads boolean + delay columns from a row', () => {
    const s = mapSettings({
      snapshot_retention_limit: 8,
      search_auto_clear_enabled: 0,
      search_auto_clear_delay: 20,
      tags_auto_clear_enabled: 1,
      tags_auto_clear_delay: 60,
    });
    expect(s.snapshotRetentionLimit).toBe(8);
    expect(s.searchAutoClearEnabled).toBe(false);
    expect(s.searchAutoClearDelay).toBe(20);
    expect(s.tagsAutoClearEnabled).toBe(true);
    expect(s.tagsAutoClearDelay).toBe(60);
  });

  it('falls back per-field when a column is missing or malformed', () => {
    const s = mapSettings({
      snapshot_retention_limit: -1,
      search_auto_clear_enabled: 1,
      // search_auto_clear_delay missing → default 15
      tags_auto_clear_delay: 'not-a-number', // → default 30
    });
    expect(s.snapshotRetentionLimit).toBe(-1);
    expect(s.searchAutoClearDelay).toBe(DEFAULT_SEARCH_AUTO_CLEAR.delay);
    expect(s.tagsAutoClearDelay).toBe(DEFAULT_TAGS_AUTO_CLEAR.delay);
  });

  it('accepts booleans as true/false values too', () => {
    const s = mapSettings({
      search_auto_clear_enabled: true,
      tags_auto_clear_enabled: false,
      search_auto_clear_delay: 15,
      tags_auto_clear_delay: 30,
    });
    expect(s.searchAutoClearEnabled).toBe(true);
    expect(s.tagsAutoClearEnabled).toBe(false);
  });
});

describe('parseAutoClearDelay', () => {
  it('accepts a positive integer within bounds', () => {
    expect(parseAutoClearDelay('15', 'searchAutoClearDelay')).toBe(15);
    expect(parseAutoClearDelay(30, 'searchAutoClearDelay')).toBe(30);
  });

  it('rejects zero, negatives, non-integers, and out-of-range values', () => {
    expect(() => parseAutoClearDelay('0', 'searchAutoClearDelay')).toThrow();
    expect(() => parseAutoClearDelay(-5, 'searchAutoClearDelay')).toThrow();
    expect(() => parseAutoClearDelay(86401, 'searchAutoClearDelay')).toThrow();
    expect(() => parseAutoClearDelay('abc', 'searchAutoClearDelay')).toThrow();
    expect(() => parseAutoClearDelay(15.5, 'searchAutoClearDelay')).toThrow();
  });
});

describe('parseRetentionLimit', () => {
  it('accepts -1 and positive integers', () => {
    expect(parseRetentionLimit(-1)).toBe(-1);
    expect(parseRetentionLimit('5')).toBe(5);
  });

  it('rejects 0 and negatives other than -1', () => {
    expect(() => parseRetentionLimit(0)).toThrow();
    expect(() => parseRetentionLimit(-2)).toThrow();
  });
});

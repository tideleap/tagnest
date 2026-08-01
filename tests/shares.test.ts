import { describe, it, expect } from 'vitest';
import {
  normalizeSlug,
  slugFromTitle,
  assertValidSlug,
  THEMES,
  MAX_PUBLIC_ITEMS,
} from '../functions/_lib/shares';
import { badRequest } from '../functions/_lib/http';

describe('normalizeSlug', () => {
  it('lowercases and replaces non-alphanumerics with a single hyphen', () => {
    expect(normalizeSlug('My Cool Page!')).toBe('my-cool-page');
    expect(normalizeSlug('  leading-and-trailing--  ')).toBe('leading-and-trailing');
  });

  it('strips everything for a CJK title', () => {
    expect(normalizeSlug('我的收藏')).toBe('');
  });
});

describe('slugFromTitle', () => {
  it('uses the normalised title when it is long enough', () => {
    expect(slugFromTitle('Frontend Links')).toBe('frontend-links');
  });

  it('falls back to a random list- slug for CJK or too-short titles', () => {
    const cjk = slugFromTitle('设计资源');
    expect(cjk.startsWith('list-')).toBe(true);
    const short = slugFromTitle('ab');
    expect(short.startsWith('list-')).toBe(true);
  });

  it('avoids reserved slugs', () => {
    expect(slugFromTitle('settings')).toMatch(/^list-/);
  });
});

describe('assertValidSlug', () => {
  it('accepts a well-formed slug', () => {
    expect(() => assertValidSlug('my-cool-page')).not.toThrow();
  });

  it('rejects reserved words', () => {
    expect(() => assertValidSlug('admin')).toThrow(badRequest('').constructor);
  });

  it('rejects bad characters and wrong length', () => {
    expect(() => assertValidSlug('AB')).toThrow();
    expect(() => assertValidSlug('has space')).toThrow();
  });
});

describe('share constants', () => {
  it('exposes sane themes and a public cap', () => {
    expect(THEMES).toContain('default');
    expect(MAX_PUBLIC_ITEMS).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import {
  newId,
  randomToken,
  base64UrlEncode,
  base64UrlDecode,
  nowIso,
  isoFromNow,
} from '../functions/_lib/ids';

const ALPHABET = /^[0-9a-z]+$/;

describe('newId', () => {
  it('is 22 chars of base36 (8-char time prefix + 14 random)', () => {
    const id = newId();
    expect(id).toHaveLength(22);
    expect(id).toMatch(ALPHABET);
  });

  it('produces distinct ids on successive calls', () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
  });

  it('sorts chronologically by prefix', () => {
    // The 8-char base36 prefix is time-based, so a later id is >= an earlier one.
    const earlier = newId();
    const later = newId();
    expect(later.slice(0, 8) >= earlier.slice(0, 8)).toBe(true);
  });
});

describe('randomToken', () => {
  it('returns a url-safe token of the requested entropy', () => {
    const t = randomToken(32);
    expect(t).not.toMatch(/[+/=]/);
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(encoded))).toEqual(Array.from(bytes));
  });

  it('round-trips a unicode string', () => {
    const text = new TextEncoder().encode('书签 管理 🔖');
    const encoded = base64UrlEncode(text);
    expect(new TextDecoder().decode(base64UrlDecode(encoded))).toBe('书签 管理 🔖');
  });
});

describe('timestamps', () => {
  it('nowIso returns a valid ISO string', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('isoFromNow is in the future for positive deltas', () => {
    expect(isoFromNow(60_000) > nowIso()).toBe(true);
  });
});

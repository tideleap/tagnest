import { describe, it, expect } from 'vitest';
import {
  KEY_PREFIX,
  generateKey,
  looksLikeApiKey,
  parseScopes,
  mapApiKey,
  createApiKey,
  resolveApiKey,
} from '../functions/_lib/apikeys';
import { makeEnv } from './_support/dbMock';

describe('generateKey', () => {
  it('produces a tnk_ prefixed token of stable shape', () => {
    const token = generateKey();
    expect(token.startsWith(KEY_PREFIX)).toBe(true);
    // 32 bytes -> 43 base64url chars after the 4-char prefix.
    expect(token.length).toBe(KEY_PREFIX.length + 43);
  });

  it('produces unique tokens', () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});

describe('looksLikeApiKey', () => {
  it('recognises our prefix and rejects JWTs / garbage', () => {
    expect(looksLikeApiKey(`tnk_${'a'.repeat(43)}`)).toBe(true);
    expect(looksLikeApiKey('eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(false);
    expect(looksLikeApiKey('not-a-key')).toBe(false);
  });
});

describe('parseScopes', () => {
  it('defaults to read,write when omitted', () => {
    expect(parseScopes(undefined)).toEqual(['read', 'write']);
    expect(parseScopes(null)).toEqual(['read', 'write']);
  });

  it('dedupes and filters unknown scopes', () => {
    expect(parseScopes(['read', 'read', 'bogus'])).toEqual(['read']);
  });

  it('prepends read when only write is requested', () => {
    expect(parseScopes(['write'])).toEqual(['read', 'write']);
  });

  it('accepts a comma string', () => {
    expect(parseScopes('read,write')).toEqual(['read', 'write']);
  });

  it('rejects an empty result', () => {
    expect(() => parseScopes(['nope'])).toThrow();
  });
});

describe('createApiKey / resolveApiKey', () => {
  it('stores only a SHA-256 digest, never the plaintext', async () => {
    const env = makeEnv();
    const created = await createApiKey(env, 'user-1', '我的扩展', ['read', 'write'], null);

    // The plaintext is returned exactly once.
    expect(created.token.startsWith(KEY_PREFIX)).toBe(true);
    // No row in the mock carries the plaintext token.
    const stored = (env.DB as any).api_keys[0];
    expect(stored.token_hash).not.toBe(created.token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves a key by digest and reports its scopes', async () => {
    const env = makeEnv();
    const created = await createApiKey(env, 'user-2', '脚本', ['read'], null);
    const resolved = await resolveApiKey(env, created.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.userId).toBe('user-2');
    expect(resolved!.scopes).toEqual(['read']);
  });

  it('returns null for an unknown token', async () => {
    const env = makeEnv();
    expect(await resolveApiKey(env, 'tnk_' + 'z'.repeat(43))).toBeNull();
  });

  it('rejects an expired key', async () => {
    const env = makeEnv();
    const created = await createApiKey(env, 'user-3', '临时', ['read', 'write'], '2000-01-01T00:00:00.000Z');
    expect(await resolveApiKey(env, created.token)).toBeNull();
  });

  it('maps a row without leaking the hash', () => {
    const mapped = mapApiKey({
      id: 'k1',
      name: '扩展',
      prefix: 'tnk_abcdefghijkl',
      scopes: 'read,write',
      last_used_at: null,
      created_at: '2026-08-01T00:00:00.000Z',
      expires_at: null,
    });
    expect(mapped.id).toBe('k1');
    expect(mapped.prefix).toBe('tnk_abcdefghijkl');
    expect(mapped.scopes).toEqual(['read', 'write']);
    expect((mapped as Record<string, unknown>).tokenHash).toBeUndefined();
  });
});

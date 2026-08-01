import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  verifyAccessToken,
} from '../functions/_lib/auth';

// In tests we use the dev fallback secret (no JWT_SECRET set) so signing and
// verifying use the same key. A second env with a real secret must reject the
// first env's tokens.
const devEnv = {} as Env;
const otherEnv = { JWT_SECRET: 'a-distinct-production-secret-key-1234567890' } as Env;

describe('password hashing (PBKDF2-HMAC-SHA256)', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple', devEnv);
    expect(stored.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple', devEnv);
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('rejects a malformed stored value', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('produces a different salt each time', async () => {
    const a = await hashPassword('same', devEnv);
    const b = await hashPassword('same', devEnv);
    expect(a).not.toBe(b);
  });
});

describe('access tokens (JWT HS256)', () => {
  it('signs and verifies a token for the subject', async () => {
    const token = await signAccessToken('user-42', devEnv);
    expect(await verifyAccessToken(token, devEnv)).toBe('user-42');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken('user-42', devEnv);
    expect(await verifyAccessToken(token, otherEnv)).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken('user-42', devEnv);
    const [h, p] = token.split('.');
    const tampered = `${h}.${p}.ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ`;
    expect(await verifyAccessToken(tampered, devEnv)).toBeNull();
  });

  it('rejects a malformed token', async () => {
    expect(await verifyAccessToken('only.two.parts', devEnv)).toBeNull();
    expect(await verifyAccessToken('garbage', devEnv)).toBeNull();
  });
});

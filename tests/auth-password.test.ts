import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { hashPassword, verifyPassword } from '../functions/_lib/auth';
import { onRequestPost } from '../functions/api/auth/password';
import { MockDb, makeEnv } from './_support/dbMock';

function makeCtx(env: Env, userId: string, body: unknown) {
  return {
    request: new Request('https://tagnest.test/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    data: { userId },
  } as any;
}

describe('POST /api/auth/password', () => {
  it('re-hashes and stores the new password when the current one is correct', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    db.users.push({
      id: 'u1',
      email: 'me@example.com',
      password_hash: await hashPassword('oldpass123', env),
    });

    const res = await onRequestPost(makeCtx(env, 'u1', {
      currentPassword: 'oldpass123',
      newPassword: 'newpass456',
    }));

    expect(res.status).toBe(200);
    const row = db.users.find((r) => r.id === 'u1')!;
    expect(await verifyPassword('newpass456', row.password_hash as string)).toBe(true);
    expect(await verifyPassword('oldpass123', row.password_hash as string)).toBe(false);
  });

  it('rejects a wrong current password without changing the hash', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const original = await hashPassword('oldpass123', env);
    db.users.push({ id: 'u1', email: 'me@example.com', password_hash: original });

    await expect(
      onRequestPost(makeCtx(env, 'u1', { currentPassword: 'wrong', newPassword: 'newpass456' })),
    ).rejects.toMatchObject({ status: 400, code: 'current_password_invalid' });

    expect(db.users.find((r) => r.id === 'u1')!.password_hash).toBe(original);
  });

  it('rejects a too-short new password', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    db.users.push({
      id: 'u1',
      email: 'me@example.com',
      password_hash: await hashPassword('oldpass123', env),
    });

    await expect(
      onRequestPost(makeCtx(env, 'u1', { currentPassword: 'oldpass123', newPassword: 'short' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('records a throttle failure on a wrong current password', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    db.users.push({
      id: 'u1',
      email: 'me@example.com',
      password_hash: await hashPassword('oldpass123', env),
    });

    await expect(
      onRequestPost(makeCtx(env, 'u1', { currentPassword: 'wrong', newPassword: 'newpass456' })),
    ).rejects.toBeTruthy();

    expect(
      db.auth_attempts.filter((r) => r.bucket === 'email:me@example.com').length,
    ).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import {
  clientIp,
  assertNotThrottled,
  recordFailure,
  clearFailures,
} from '../functions/_lib/throttle';
import { makeEnv } from './_support/dbMock';
import { ApiException } from '../functions/_lib/http';

/** A request carrying the given CF-Connecting-IP header. */
function req(ip: string): Request {
  return new Request('https://tagnest.pages.dev/api/auth/login', {
    headers: { 'CF-Connecting-IP': ip },
  });
}

describe('clientIp', () => {
  it('prefers CF-Connecting-IP over X-Forwarded-For', () => {
    const r = new Request('https://x/', {
      headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '9.9.9.9, 1.2.3.4' },
    });
    expect(clientIp(r)).toBe('1.2.3.4');
  });

  it('falls back to X-Forwarded-For locally', () => {
    const r = new Request('https://x/', { headers: { 'X-Forwarded-For': '5.6.7.8' } });
    expect(clientIp(r)).toBe('5.6.7.8');
  });
});

describe('assertNotThrottled', () => {
  it('allows when both buckets are under the limit', async () => {
    const env = makeEnv();
    await expect(assertNotThrottled(env, req('1.1.1.1'), 'a@example.com')).resolves.toBeUndefined();
  });

  it('throws 429 once the per-IP bucket hits the cap', async () => {
    const env = makeEnv();
    const db = env.DB as any;
    // MAX_PER_IP = 20. Seed 20 recent failures for this IP.
    for (let i = 0; i < 20; i++) {
      db.auth_attempts.push({ id: `a${i}`, bucket: 'ip:1.1.1.1', created_at: '2099-01-01T00:00:00.000Z' });
    }
    let thrown: unknown = null;
    try {
      await assertNotThrottled(env, req('1.1.1.1'), 'b@example.com');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).status).toBe(429);
  });

  it('throws 429 once the per-email bucket hits the cap', async () => {
    const env = makeEnv();
    const db = env.DB as any;
    for (let i = 0; i < 8; i++) {
      db.auth_attempts.push({ id: `e${i}`, bucket: 'email:lock@example.com', created_at: '2099-01-01T00:00:00.000Z' });
    }
    await expect(assertNotThrottled(env, req('2.2.2.2'), 'lock@example.com')).rejects.toBeInstanceOf(
      ApiException,
    );
  });

  it('ignores old attempts outside the 15-minute window', async () => {
    const env = makeEnv();
    const db = env.DB as any;
    for (let i = 0; i < 20; i++) {
      db.auth_attempts.push({ id: `o${i}`, bucket: 'ip:3.3.3.3', created_at: '2000-01-01T00:00:00.000Z' });
    }
    // All seeded hits are stale, so the brake stays open.
    await expect(assertNotThrottled(env, req('3.3.3.3'), 'c@example.com')).resolves.toBeUndefined();
  });
});

describe('recordFailure / clearFailures', () => {
  it('records one row per bucket and clears the email bucket on success', async () => {
    const env = makeEnv();
    const db = env.DB as any;
    const r = req('4.4.4.4');

    await recordFailure(env, r, 'd@example.com');
    expect(db.auth_attempts.filter((x: any) => x.bucket === 'ip:4.4.4.4')).toHaveLength(1);
    expect(db.auth_attempts.filter((x: any) => x.bucket === 'email:d@example.com')).toHaveLength(1);

    await clearFailures(env, 'd@example.com');
    expect(db.auth_attempts.filter((x: any) => x.bucket === 'email:d@example.com')).toHaveLength(0);
    // The IP bucket is intentionally retained for cross-account spraying.
    expect(db.auth_attempts.filter((x: any) => x.bucket === 'ip:4.4.4.4')).toHaveLength(1);
  });
});

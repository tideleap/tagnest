import type { Env } from './env';
import { ApiException } from './http';
import { isoFromNow, newId, nowIso } from './ids';

/**
 * Credential-stuffing brake for the auth endpoints.
 *
 * Counts recent failures in D1 rather than in memory: Pages Functions run in
 * many isolates across many colos, so an in-process counter would reset
 * constantly and protect nothing.
 *
 * Two independent buckets:
 *   * per IP    — stops one host from spraying many accounts
 *   * per email — stops a botnet from spraying one account
 *
 * Only *failures* are recorded, and a success clears the account bucket, so a
 * legitimate user who mistypes twice is never locked out by their own retry.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 20;
const MAX_PER_EMAIL = 8;

/** Cheap opportunistic GC; the table would otherwise grow without bound. */
const SWEEP_PROBABILITY = 0.05;

export function clientIp(request: Request): string {
  // CF-Connecting-IP is set by the edge and cannot be spoofed by the client;
  // X-Forwarded-For can be, so it is only a local-dev fallback.
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

function bucketsFor(request: Request, email: string | null): string[] {
  const buckets = [`ip:${clientIp(request)}`];
  if (email) buckets.push(`email:${email.toLowerCase()}`);
  return buckets;
}

async function countSince(env: Env, bucket: string, since: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM auth_attempts WHERE bucket = ? AND created_at > ?`,
  )
    .bind(bucket, since)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/**
 * Throws 429 when either bucket is over its limit.
 *
 * Call before verifying credentials. Missing table (a database that has not
 * run migration 0002) degrades to "no throttling" rather than a 500 — the
 * endpoint staying up matters more than the brake during a partial rollout.
 */
export async function assertNotThrottled(
  env: Env,
  request: Request,
  email: string | null,
): Promise<void> {
  const since = isoFromNow(-WINDOW_MS);
  const [ipBucket, emailBucket] = bucketsFor(request, email);

  try {
    const ipHits = await countSince(env, ipBucket, since);
    if (ipHits >= MAX_PER_IP) throw throttled();

    if (emailBucket) {
      const emailHits = await countSince(env, emailBucket, since);
      if (emailHits >= MAX_PER_EMAIL) throw throttled();
    }
  } catch (e) {
    if (e instanceof ApiException) throw e;
    console.warn('[tagnest] throttle check unavailable', e);
  }
}

function throttled(): ApiException {
  return new ApiException(
    429,
    'too_many_attempts',
    '尝试次数过多，请 15 分钟后再试',
  );
}

/** Records one failure against both buckets. */
export async function recordFailure(
  env: Env,
  request: Request,
  email: string | null,
): Promise<void> {
  const ts = nowIso();
  try {
    await env.DB.batch(
      bucketsFor(request, email).map((bucket) =>
        env.DB.prepare(
          `INSERT INTO auth_attempts (id, bucket, created_at) VALUES (?, ?, ?)`,
        ).bind(newId(), bucket, ts),
      ),
    );
    if (Math.random() < SWEEP_PROBABILITY) {
      await env.DB.prepare(`DELETE FROM auth_attempts WHERE created_at < ?`)
        .bind(isoFromNow(-WINDOW_MS))
        .run();
    }
  } catch (e) {
    console.warn('[tagnest] throttle record failed', e);
  }
}

/** Clears the account bucket after a successful login. */
export async function clearFailures(env: Env, email: string | null): Promise<void> {
  if (!email) return;
  try {
    await env.DB.prepare(`DELETE FROM auth_attempts WHERE bucket = ?`)
      .bind(`email:${email.toLowerCase()}`)
      .run();
  } catch (e) {
    console.warn('[tagnest] throttle clear failed', e);
  }
}

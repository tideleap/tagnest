import type { Env } from './env';

/**
 * Build/version marker surfaced by `/api/health` so the live deployment can be
 * identified directly — i.e. to confirm a given fix actually reached production
 * instead of inferring it from CI status. Bumped on each deploy that must be
 * distinguishable. Because it is committed ON TOP of the change under test, a
 * live marker proves that change (and everything before it) is live.
 */
export const BUILD_VERSION = '2026-09-05-tag-cycle-repair';

export interface HealthReport {
  status: 'ok' | 'degraded';
  /** Per-component readiness: 'ok' | 'missing' | 'error: <detail>'. */
  checks: Record<string, string>;
  timestamp: string;
  /** Build marker identifying the deployed code (see BUILD_VERSION). */
  build: string;
}

/**
 * Readiness probe used by the public `/api/health` endpoint and unit-tested
 * without touching real bindings. A component that is merely absent (KV not
 * bound, JWT secret not set) reports `missing` rather than throwing, so the
 * endpoint stays informative instead of 500-ing.
 */
export async function probeHealth(env: Env): Promise<HealthReport> {
  const checks: Record<string, string> = {};

  if (env.DB) {
    try {
      await env.DB.prepare('SELECT 1').first();
      checks.database = 'ok';
    } catch (e) {
      checks.database = e instanceof Error ? `error: ${e.message}` : 'error';
    }
  } else {
    checks.database = 'missing';
  }

  checks.shareCache = env.SHARE_CACHE ? 'ok' : 'missing';
  checks.auth = env.JWT_SECRET ? 'ok' : 'missing';

  const degraded = Object.values(checks).some((v) => v !== 'ok');
  return {
    status: degraded ? 'degraded' : 'ok',
    checks,
    timestamp: new Date().toISOString(),
    build: BUILD_VERSION,
  };
}

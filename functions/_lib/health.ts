import type { Env } from './env';

export interface HealthReport {
  status: 'ok' | 'degraded';
  /** Per-component readiness: 'ok' | 'missing' | 'error: <detail>'. */
  checks: Record<string, string>;
  timestamp: string;
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
  };
}

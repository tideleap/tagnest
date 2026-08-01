import type { Env, RequestData } from '../_lib/env';
import { json } from '../_lib/http';
import { probeHealth } from '../_lib/health';

/**
 * Readiness probe. Always returns HTTP 200 so naive uptime monitors see the
 * process as up; degraded wiring (e.g. KV unbound, JWT secret absent, DB
 * unreachable) is reported in the `status`/`checks` fields for smarter
 * monitors to alert on. HTTP status is unchanged from the prior liveness
 * contract to avoid breaking existing probes.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async ({ env }) => {
  const report = await probeHealth(env);
  return json(report);
};

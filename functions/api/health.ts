import type { Env, RequestData } from '../_lib/env';
import { json } from '../_lib/http';

/** Liveness probe: confirms the Function booted and the D1 binding responds. */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async ({ env }) => {
  let database = 'ok';
  try {
    await env.DB.prepare('SELECT 1').first();
  } catch (e) {
    database = e instanceof Error ? `error: ${e.message}` : 'error';
  }
  return json({ status: database === 'ok' ? 'ok' : 'degraded', database });
};

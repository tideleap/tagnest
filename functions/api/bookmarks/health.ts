import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import { buildHealthReport } from '../../_lib/healthcheck';

/**
 * O1 — structural health report: duplicate groups, orphan tags, score.
 * Instant (pure SQL), safe to poll. Liveness probing lives at
 * POST /api/bookmarks/health/probe because it is slow and side-effectful.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const report = await buildHealthReport(ctx.env, userId);
  return json(report);
};

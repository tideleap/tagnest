import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, readJson } from '../../../_lib/http';
import { PROBE_MAX_IDS, probeBookmarks } from '../../../_lib/healthcheck';

/**
 * O1 — liveness probe. POST because it performs outbound fetches; the batch
 * is capped at PROBE_MAX_IDS so a single request can never fan out into an
 * unbounded burst. Clients probe their library incrementally (a few batches
 * per click) and read the results back from this response only.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ ids?: unknown }>(ctx.request);
  const raw = body.ids;
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('未选择要检查的书签');
  const ids = [...new Set(raw.map(String).filter(Boolean))].slice(0, PROBE_MAX_IDS);
  if (ids.length === 0) throw badRequest('未选择要检查的书签');

  const results = await probeBookmarks(ctx.env, userId, ids);
  return json({ results });
};

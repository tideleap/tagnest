import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { json } from '../../../_lib/http';
import { classifyTag, countPending, listPendingSuggestions, toApiSuggestion } from '../../../_lib/ai';

/**
 * The review queue.
 *
 * This is the endpoint that makes it safe to give the model real
 * responsibility. Previously the model wrote tags straight into the library:
 * unattributed, unreviewable and irreversible, which meant the only sensible
 * setting was "off". Proposals now land here first, ordered by confidence, and
 * nothing touches a bookmark until the user says so.
 *
 * Query params:
 *   `limit`  1-500, default 200
 *   `jobId`  restrict to one run, for the "review what I just generated" view
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const url = new URL(ctx.request.url);

  const rawLimit = Number(url.searchParams.get('limit') ?? 200);
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 200;
  const jobId = url.searchParams.get('jobId');

  const [rows, total] = await Promise.all([
    listPendingSuggestions(ctx.env, userId, limit, jobId),
    countPending(ctx.env, userId),
  ]);

  // Enrich each suggestion with its 一级/二级 hierarchy path so the review
  // panel can group by category as well as by bookmark or topic.
  const suggestions = rows.map((row) => {
    const path = classifyTag(row.tagName);
    return {
      ...toApiSuggestion(row),
      category: path?.[0] ?? null,
      subcategory: path?.[1] ?? null,
    };
  });

  return json({ suggestions, total });
};

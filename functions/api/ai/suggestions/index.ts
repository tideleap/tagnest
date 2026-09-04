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
 *   `offset` 0+, default 0 — B-20: page through the queue (limit alone capped
 *            review at the first 500 rows; anything beyond was unreachable)
 *   `jobId`  restrict to one run, for the "review what I just generated" view
 *   `kind`   'tag' | 'category' (CategorySync migration 0024). Filters the
 *            unified queue to one proposal type; absent returns both.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const url = new URL(ctx.request.url);

  const rawLimit = Number(url.searchParams.get('limit') ?? 200);
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 200;
  const rawOffset = Number(url.searchParams.get('offset') ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const jobId = url.searchParams.get('jobId');

  const rawKind = url.searchParams.get('kind');
  const kind =
    rawKind === 'tag' || rawKind === 'category' || rawKind === 'rename' ? rawKind : null;

  const [rows, total] = await Promise.all([
    listPendingSuggestions(ctx.env, userId, limit, jobId, kind, offset),
    // B-20: total 与列表同口径（按 kind / jobId 过滤），前端分页才有意义。
    countPending(ctx.env, userId, kind, jobId),
  ]);

  // Enrich each suggestion with its 一级/二级 hierarchy path so the review
  // panel can group by category as well as by bookmark or topic.
  const suggestions = rows.map((row) => {
    // A category row's tagName already IS the full path ("开发技术 > 前端开发"),
    // so split it rather than re-deriving; a tag row gets the classifier path.
    // A rename row carries the NEW title in tagName and the ORIGINAL in topic;
    // no hierarchy applies.
    if (row.kind === 'category') {
      const parts = row.tagName.split('>').map((p) => p.trim()).filter(Boolean);
      return {
        ...toApiSuggestion(row),
        category: parts[0] ?? null,
        subcategory: parts[1] ?? null,
      };
    }
    if (row.kind === 'rename') {
      return { ...toApiSuggestion(row), category: null, subcategory: null };
    }
    const path = classifyTag(row.tagName);
    return {
      ...toApiSuggestion(row),
      category: path?.[0] ?? null,
      subcategory: path?.[1] ?? null,
    };
  });

  return json({ suggestions, total });
};

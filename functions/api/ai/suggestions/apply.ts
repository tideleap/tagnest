import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, readJson } from '../../../_lib/http';
import { countPending, decideSuggestions } from '../../../_lib/ai';

/** Ceiling for one accept/reject call. Keeps the D1 batch a sane size. */
const MAX_DECISIONS = 500;

/**
 * Accepts or rejects proposals.
 *
 * Three shapes, because review happens at three granularities and forcing the
 * client to expand a bulk action into 400 ids would be silly:
 *
 *   { action, ids:  [...] }        one, or a hand-picked set
 *   { action, bookmarkId: "..." }  everything proposed for one bookmark
 *   { action, jobId: "..." }       everything from one run — the "looks good,
 *                                  apply it all" button
 *
 * Accepted tags are written with `source = 'ai'` and their confidence, which
 * is what makes AI contribution measurable and "undo the AI's work" possible.
 * A rejection is remembered: `saveSuggestions` will not re-propose the same
 * tag for that bookmark on a later run, so the queue does not fight the user.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{
    action?: unknown;
    ids?: unknown;
    jobId?: unknown;
    bookmarkId?: unknown;
  }>(ctx.request);

  const action = String(body.action ?? '');
  if (action !== 'accept' && action !== 'reject') throw badRequest('操作类型无效');

  let ids: string[] = Array.isArray(body.ids)
    ? [...new Set(body.ids.map(String))].filter(Boolean).slice(0, MAX_DECISIONS)
    : [];

  // Bulk shapes resolve to ids server-side so the decision logic stays in one
  // place and ownership is enforced by the same WHERE clause.
  if (ids.length === 0 && (body.jobId || body.bookmarkId)) {
    const clause = body.jobId ? 'job_id = ?' : 'bookmark_id = ?';
    const value = String(body.jobId ?? body.bookmarkId);

    const rows = await ctx.env.DB.prepare(
      `SELECT id FROM tag_suggestions
        WHERE user_id = ? AND status = 'pending' AND ${clause}
        ORDER BY confidence DESC
        LIMIT ?`,
    )
      .bind(userId, value, MAX_DECISIONS)
      .all<{ id: string }>();

    ids = rows.results.map((r) => r.id);
  }

  if (ids.length === 0) throw badRequest('没有可处理的标签建议');

  const outcome = await decideSuggestions(ctx.env, userId, ids, action);
  const pending = await countPending(ctx.env, userId);

  return json({ ...outcome, pending });
};

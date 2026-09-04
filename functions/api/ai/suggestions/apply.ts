import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, readJson } from '../../../_lib/http';
import {
  countPending,
  decideCategorySuggestions,
  decideRenameSuggestions,
  decideSuggestions,
} from '../../../_lib/ai';

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
 * `kind` (CategorySync migration 0024) selects which queue the decision lands in:
 *   - 'tag' (default) → `decideSuggestions` writes `bookmark_tags`;
 *   - 'category'      → `decideCategorySuggestions` writes the single
 *                       `bookmark_primary_category` placement instead (PRD §5.2);
 *   - 'rename'        → `decideRenameSuggestions` rewrites `bookmarks.title`
 *                       (Phase B conservative title cleanup).
 * The review UI filters by kind, so it always knows which one it is applying.
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
    /** 'tag' (default) or 'category' — which queue the decision applies to. */
    kind?: unknown;
    /** When a single suggestion is renamed before accept (Phase 4 edit). */
    renameTo?: unknown;
  }>(ctx.request);

  const action = String(body.action ?? '');
  if (action !== 'accept' && action !== 'reject') throw badRequest('操作类型无效');

  const kind = body.kind === 'category' ? 'category' : body.kind === 'rename' ? 'rename' : 'tag';

  // A rename only makes sense on a single TAG accept; cap length to match tags.
  const renameTo =
    kind === 'tag' && typeof body.renameTo === 'string' ? body.renameTo.slice(0, 64) : undefined;

  let ids: string[] = Array.isArray(body.ids)
    ? [...new Set(body.ids.map(String))].filter(Boolean).slice(0, MAX_DECISIONS)
    : [];

  // Bulk shapes resolve to ids server-side so the decision logic stays in one
  // place and ownership is enforced by the same WHERE clause. The resolution is
  // scoped to the requested kind so a "apply the whole run" never mixes queues.
  //
  // B-20（第二轮审计）: 整批解析带 LIMIT（MAX_DECISIONS）。一次运行产生 >500 条
  // 待确认时，「全部应用」原先静默只处理前 500 条。现在先数一遍匹配总量，命中
  // LIMIT 就在响应里带 `truncated: true` + `totalMatched`，由前端提示分次确认，
  // 批量操作语义不再撒谎。
  let truncated = false;
  let totalMatched = 0;
  if (ids.length === 0 && (body.jobId || body.bookmarkId)) {
    const clause = body.jobId ? 'job_id = ?' : 'bookmark_id = ?';
    const value = String(body.jobId ?? body.bookmarkId);

    const countRow = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tag_suggestions
        WHERE user_id = ? AND status = 'pending' AND kind = ? AND ${clause}`,
    )
      .bind(userId, kind, value)
      .first<{ n: number }>();
    totalMatched = Number(countRow?.n ?? 0);
    truncated = totalMatched > MAX_DECISIONS;

    const rows = await ctx.env.DB.prepare(
      `SELECT id FROM tag_suggestions
        WHERE user_id = ? AND status = 'pending' AND kind = ? AND ${clause}
        ORDER BY confidence DESC
        LIMIT ?`,
    )
      .bind(userId, kind, value, MAX_DECISIONS)
      .all<{ id: string }>();

    ids = rows.results.map((r) => r.id);
  }

  if (ids.length === 0) {
    const emptyHint =
      kind === 'category'
        ? '没有可处理的分类建议'
        : kind === 'rename'
          ? '没有可处理的命名建议'
          : '没有可处理的标签建议';
    throw badRequest(emptyHint);
  }

  if (kind === 'category') {
    const outcome = await decideCategorySuggestions(ctx.env, userId, ids, action);
    const pending = await countPending(ctx.env, userId);
    return json({ ...outcome, pending, truncated, totalMatched });
  }

  if (kind === 'rename') {
    const outcome = await decideRenameSuggestions(ctx.env, userId, ids, action);
    const pending = await countPending(ctx.env, userId);
    return json({ ...outcome, pending, tagsCreated: 0, truncated, totalMatched });
  }

  // Edit-before-accept is single-suggestion only; pass the new spelling so
  // `decideSuggestions` records a 'modified' event and accepts under the new name.
  const opts = ids.length === 1 && renameTo ? { renameTo } : undefined;

  const outcome = await decideSuggestions(ctx.env, userId, ids, action, opts);
  const pending = await countPending(ctx.env, userId);

  return json({ ...outcome, pending, truncated, totalMatched });
};

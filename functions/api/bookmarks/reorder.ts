import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';

/**
 * Persists a drag-and-drop arrangement.
 *
 * The client sends the ids of the currently visible list in their new order,
 * top first. Rewriting the whole visible window rather than diffing a single
 * move keeps the contract trivial and idempotent — replaying the same request
 * produces the same table — at the cost of one UPDATE per row, which is
 * bounded by the page size.
 *
 * Weights descend in steps of STEP so the ordering stays stable when other
 * rows are appended later, and so a future single-item insert can be given a
 * midpoint value without renumbering.
 */

const STEP = 1000;
const MAX_IDS = 500;

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ ids?: unknown }>(ctx.request);

  if (!Array.isArray(body.ids)) throw badRequest('ids 必须是数组');

  const ids = [...new Set(body.ids.map((v) => String(v)).filter(Boolean))];
  if (ids.length === 0) throw badRequest('ids 不能为空');
  if (ids.length > MAX_IDS) throw badRequest(`一次最多排序 ${MAX_IDS} 条`);

  // Verify ownership in one query. Without this, a caller could renumber
  // another account's rows — the UPDATE is scoped by user_id anyway, but
  // failing loudly beats silently ignoring foreign ids.
  const owned = await ctx.env.DB.prepare(
    `SELECT id FROM bookmarks WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(userId, ...ids)
    .all<{ id: string }>();

  const ownedSet = new Set(owned.results.map((r) => r.id));
  const unknown = ids.filter((id) => !ownedSet.has(id));
  if (unknown.length > 0) {
    throw badRequest(`有 ${unknown.length} 条书签不存在或不属于当前账号`);
  }

  const top = ids.length * STEP;
  await ctx.env.DB.batch(
    ids.map((id, index) =>
      ctx.env.DB.prepare(
        `UPDATE bookmarks SET manual_order = ? WHERE id = ? AND user_id = ?`,
      ).bind(top - index * STEP, id, userId),
    ),
  );

  // updated_at is deliberately untouched: reordering is a view preference,
  // not a content edit, and bumping it would scramble the "recently updated"
  // sort every time someone tidies their list.
  return json({ reordered: ids.length });
};

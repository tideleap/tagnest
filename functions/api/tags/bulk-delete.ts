import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';

/**
 * Deletes up to 100 tags in one request — the governance panel's "clear all
 * unused" action. Same semantics as DELETE /api/tags/:id: only the tag rows
 * go; bookmarks are untouched (unused tags have no links anyway).
 *
 * Ownership is enforced in the WHERE clause, so ids belonging to other users
 * simply don't match and never count toward `deleted`.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ ids?: unknown }>(ctx.request);

  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.map(String))].filter(Boolean).slice(0, 100)
    : [];
  if (ids.length === 0) throw badRequest('请选择要删除的标签');

  const ph = ids.map(() => '?').join(',');
  const result = await ctx.env.DB.prepare(
    `DELETE FROM tags WHERE user_id = ? AND id IN (${ph})`,
  )
    .bind(userId, ...ids)
    .run();

  return json({ deleted: result.meta.changes ?? 0 });
};

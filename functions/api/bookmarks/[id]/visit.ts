import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { json, notFound } from '../../../_lib/http';
import { nowIso } from '../../../_lib/ids';

/**
 * Records an open.
 *
 * Deliberately does not touch updated_at: opening a bookmark is not editing
 * it, and letting reads reshuffle the "recently updated" sort would make that
 * view useless.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  const result = await ctx.env.DB.prepare(
    `UPDATE bookmarks
        SET visit_count = visit_count + 1, last_visited_at = ?
      WHERE id = ? AND user_id = ?`,
  )
    .bind(nowIso(), String(ctx.params.id), userId)
    .run();

  // Previously this returned { ok: true } even when nothing matched, so a
  // visit against a deleted/foreign id silently "succeeded".
  if (!result.meta.changes) throw notFound('书签不存在');

  return json({ ok: true });
};

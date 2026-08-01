import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { json } from '../../../_lib/http';
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

  await ctx.env.DB.prepare(
    `UPDATE bookmarks
        SET visit_count = visit_count + 1, last_visited_at = ?
      WHERE id = ? AND user_id = ?`,
  )
    .bind(nowIso(), String(ctx.params.id), userId)
    .run();

  return json({ ok: true });
};

import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json, readJson } from '../../_lib/http';
import { readIds } from './trash';

/**
 * Irreversible delete.
 *
 * Scoped to `deleted_at IS NOT NULL` so a live bookmark can never be destroyed
 * by a stray call — everything must pass through the trash first.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  // Emptying the trash wholesale, rather than by id list.
  if (body.all === true) {
    const before = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ? AND deleted_at IS NOT NULL`,
    )
      .bind(userId)
      .first<{ c: number }>();
    await ctx.env.DB.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND deleted_at IS NOT NULL`)
      .bind(userId)
      .run();
    return json({ deleted: before?.c ?? 0 });
  }

  const ids = readIds(body);
  const placeholders = ids.map(() => '?').join(',');
  const before = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookmarks
      WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${placeholders})`,
  )
    .bind(userId, ...ids)
    .first<{ c: number }>();

  await ctx.env.DB.prepare(
    `DELETE FROM bookmarks
      WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${placeholders})`,
  )
    .bind(userId, ...ids)
    .run();

  return json({ deleted: before?.c ?? 0 });
};

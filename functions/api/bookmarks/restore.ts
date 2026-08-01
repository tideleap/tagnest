import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { readIds } from './trash';

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const ids = readIds(await readJson(ctx.request));
  const placeholders = ids.map(() => '?').join(',');

  // See trash.ts: meta.changes counts FTS trigger rows, so we count first.
  const before = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookmarks
      WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${placeholders})`,
  )
    .bind(userId, ...ids)
    .first<{ c: number }>();

  await ctx.env.DB.prepare(
    `UPDATE bookmarks SET deleted_at = NULL, updated_at = ?
      WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${placeholders})`,
  )
    .bind(nowIso(), userId, ...ids)
    .run();

  return json({ restored: before?.c ?? 0 });
};

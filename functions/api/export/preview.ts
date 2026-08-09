import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';

/**
 * GET /api/export/preview
 *
 * Returns lightweight counts to show in the export panel before the user starts
 * an export: how many bookmarks will be included (based on whether trashed ones
 * are counted), how many tags and snapshot references exist. Purely a UX aid —
 * the actual export reads the rows fresh.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  const live = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ? AND is_private = 0 AND deleted_at IS NULL`,
  )
    .bind(userId)
    .first<{ c: number }>();

  const trash = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ? AND is_private = 0 AND deleted_at IS NOT NULL`,
  )
    .bind(userId)
    .first<{ c: number }>();

  const tags = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM tags WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ c: number }>();

  const withSnapshots = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookmarks b
      WHERE b.user_id = ? AND b.is_private = 0 AND b.snapshot_key IS NOT NULL AND b.deleted_at IS NULL`,
  )
    .bind(userId)
    .first<{ c: number }>();

  const all = Number(live?.c ?? 0) + Number(trash?.c ?? 0);

  return json({
    liveCount: Number(live?.c ?? 0),
    trashCount: Number(trash?.c ?? 0),
    allCount: all,
    tagCount: Number(tags?.c ?? 0),
    snapshotCount: Number(withSnapshots?.c ?? 0),
    exportedAt: null,
  });
};

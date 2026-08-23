import type { Stats } from '../../shared/types';
import type { Env, RequestData } from '../_lib/env';
import { requireUserId } from '../_lib/auth';
import { json } from '../_lib/http';
import { PRIVATE_BOOKMARK_CLAUSE } from '../_lib/db';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // One pass over the user's rows with conditional aggregates, rather than
  // seven separate COUNT queries.
  const row = await ctx.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS bookmarks,
       SUM(CASE WHEN deleted_at IS NULL AND is_favorite = 1 THEN 1 ELSE 0 END) AS favorites,
       SUM(CASE WHEN deleted_at IS NULL AND is_archived = 1 THEN 1 ELSE 0 END) AS archived,
       SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed,
       SUM(CASE WHEN deleted_at IS NULL AND created_at >= ? THEN 1 ELSE 0 END) AS recent,
       SUM(CASE WHEN deleted_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id
           ) THEN 1 ELSE 0 END) AS untagged,
       SUM(CASE WHEN deleted_at IS NULL AND EXISTS (
             SELECT 1 FROM bookmark_primary_category bpc WHERE bpc.bookmark_id = b.id
           ) THEN 1 ELSE 0 END) AS categorized
     FROM bookmarks b WHERE b.user_id = ? AND ${PRIVATE_BOOKMARK_CLAUSE}`,
  )
    .bind(since, userId)
    .first<Record<string, number | null>>();

  const tags = await ctx.env.DB.prepare(`SELECT COUNT(*) AS c FROM tags WHERE user_id = ?`)
    .bind(userId)
    .first<{ c: number }>();

  const bookmarks = Number(row?.bookmarks ?? 0);
  const categorized = Number(row?.categorized ?? 0);
  const stats: Stats = {
    bookmarks,
    tags: Number(tags?.c ?? 0),
    favorites: Number(row?.favorites ?? 0),
    archived: Number(row?.archived ?? 0),
    trashed: Number(row?.trashed ?? 0),
    untagged: Number(row?.untagged ?? 0),
    addedLast7Days: Number(row?.recent ?? 0),
    // CS-P4-2 (C5-4): category coverage = categorized / bookmarks. The
    // complement is derived here (not in SQL) so the two always add up.
    categorized,
    uncategorized: Math.max(0, bookmarks - categorized),
  };

  return json(stats);
};

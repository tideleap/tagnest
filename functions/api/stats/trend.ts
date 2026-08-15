import type { StatsTrend } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import { PRIVATE_BOOKMARK_CLAUSE } from '../../_lib/db';

/**
 * A3 — collection trend for the report page: bookmarks added per day.
 *
 * `?days=N` (default 180, capped at 365). Only days with at least one
 * addition come back; the client fills the gaps with zeros, which keeps the
 * payload tiny for quiet libraries.
 *
 * Served by idx_bm_user_live_created (user_id, deleted_at, created_at DESC),
 * so this stays a cheap range scan even for large libraries. Calibre matches
 * /api/stats exactly: live, non-private bookmarks only.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  const raw = Number(new URL(ctx.request.url).searchParams.get('days') ?? '');
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 365) : 180;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const result = await ctx.env.DB.prepare(
    `SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS c
       FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND b.created_at >= ? AND ${PRIVATE_BOOKMARK_CLAUSE}
      GROUP BY d`,
  )
    .bind(userId, since)
    .all<{ d: string; c: number }>();

  const trend: StatsTrend = {
    days: result.results.map((row) => ({ date: row.d, count: Number(row.c) })),
  };
  return json(trend);
};

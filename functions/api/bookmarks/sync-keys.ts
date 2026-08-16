import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';

/**
 * Lightweight bookmark keys listing for two-way sync reconciliation.
 *
 * A full `GET /api/bookmarks` returns the entire bookmark object (title,
 * note, snapshots, AI summary…) which is far heavier than the sync client
 * needs: to decide what to push/pull it only requires the normalised
 * `url_key` plus an `updated_at` watermark for incremental diffing. This
 * endpoint returns exactly that, so a browser-extension reconciliation pass
 * over a 5k-bookmark library stays in the ~2.5–5MB range rather than pulling
 * full objects.
 *
 * Ordering is `(updated_at ASC, id ASC)` — a total order that makes cursor
 * pagination stable and reuses the `idx_bm_user_live_updated` index for the
 * live+user filter. Private (E2E-encrypted) rows are excluded, mirroring
 * `listBookmarks`, since their plaintext url/title is not recoverable
 * server-side and must not pollute the reconciliation set.
 */

const PAGE_SIZE = 500;

interface SyncKeyRow {
  id: string;
  url_key: string;
  updated_at: string;
  title: string;
}

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const params = new URL(ctx.request.url).searchParams;

  let cursorUpdatedAt: string | null = null;
  let cursorId: string | null = null;
  const cursor = params.get('cursor');
  if (cursor) {
    try {
      const parsed = JSON.parse(cursor) as { updatedAt?: string; id?: string };
      if (typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string') {
        cursorUpdatedAt = parsed.updatedAt;
        cursorId = parsed.id;
      }
    } catch {
      // Malformed cursor — ignore and fall back to the first page.
    }
  }

  const pageSize = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '', 10) || PAGE_SIZE, 1), PAGE_SIZE);

  let sql = `SELECT id, url_key, updated_at, title
    FROM bookmarks
    WHERE user_id = ? AND deleted_at IS NULL
      AND is_private = 0
      AND NOT EXISTS (
        SELECT 1 FROM bookmark_tags bt
        JOIN tags t ON t.id = bt.tag_id
        WHERE bt.bookmark_id = bookmarks.id AND t.user_id = ? AND t.is_private = 1
      )`;
  const bindArgs: unknown[] = [userId, userId];

  if (cursorUpdatedAt && cursorId) {
    sql += ` AND (updated_at > ? OR (updated_at = ? AND id > ?))`;
    bindArgs.push(cursorUpdatedAt, cursorUpdatedAt, cursorId);
  }

  sql += ` ORDER BY updated_at ASC, id ASC LIMIT ?`;
  bindArgs.push(pageSize);

  const rows = await ctx.env.DB.prepare(sql)
    .bind(...(bindArgs as (string | number)[]))
    .all<SyncKeyRow>();

  const items = (rows.results ?? []).map((r) => ({
    id: r.id,
    urlKey: r.url_key,
    updatedAt: r.updated_at,
    title: r.title ?? '',
  }));

  const hasMore = items.length === pageSize;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? JSON.stringify({ updatedAt: last.updatedAt, id: last.id }) : null;

  return json({
    items,
    cursor: nextCursor,
    hasMore,
  });
};

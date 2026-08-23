import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import { attachTags } from '../../_lib/db';
import { deriveCategoryPaths } from '../../_lib/ai/store';

/**
 * Incremental bookmark pull for two-way browser-extension sync.
 *
 * Unlike `sync-keys` (a read-only reconciliation listing) this endpoint emits
 * the *full lightweight object* the extension needs to write TagNest state back
 * into the browser: canonical `url_key`, `url`, `title`, `tagNames`, the
 * derived `categoryPath` (C4-1), and a `deletedAt` flag. It is the read half
 * of the hub-and-spoke changelog — the extension is a spoke that periodically
 * pulls everything that changed since its watermark and replays it locally.
 *
 * Watermark model
 * ---------------
 * `updated_at` is the unified change timestamp: a normal upsert bumps it, a
 * soft-delete bumps it too (see `trash.ts`), and a primary-category placement
 * write bumps it as well (see `store.ts`), so a single cursor over
 * `(updated_at, id)` captures edits, deletions, and category moves. Deleted
 * rows are *included* (we do NOT filter `deleted_at IS NULL`) so the deletion
 * can be propagated to the browser as a removal. `since` and `cursor` are
 * folded into one keyset: a bare `since` becomes `{updatedAt: since, id: ''}`
 * (the empty id makes `id > ''` true for every real id, i.e.
 * `updated_at >= since`); a `cursor` carries the real last id for stable
 * pagination.
 *
 * Category path (C4-1)
 * --------------------
 * Each item carries `categoryPath` — the bookmark's accepted primary placement
 * walked up `tags.parent_id` to a root-to-leaf name array, or `null` when the
 * bookmark is uncategorised. The path is never stored; it is derived in memory
 * from one tag-tree load per page (`deriveCategoryPaths`), so the tree and the
 * path can never disagree. Soft-deleted rows report `null` (their placement is
 * irrelevant once the bookmark is gone from the browser).
 *
 * Privacy
 * -------
 * Private (E2E-encrypted) rows and category-private rows are excluded, exactly
 * like `sync-keys`, because their plaintext url/title is unrecoverable
 * server-side and must never reach an extension client.
 */

const PAGE_SIZE = 500;

interface SyncPullRow {
  id: string;
  url_key: string;
  url: string;
  title: string;
  updated_at: string;
  deleted_at: string | null;
}

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const params = new URL(ctx.request.url).searchParams;

  // Normalise since/cursor into a single keyset cursor.
  let cursorUpdatedAt: string | null = null;
  let cursorId = '';
  const cursor = params.get('cursor');
  if (cursor) {
    try {
      const parsed = JSON.parse(cursor) as { updatedAt?: string; id?: string };
      if (typeof parsed.updatedAt === 'string') {
        cursorUpdatedAt = parsed.updatedAt;
        cursorId = typeof parsed.id === 'string' ? parsed.id : '';
      }
    } catch {
      // Malformed cursor — fall back to the first page (no watermark).
    }
  } else {
    const since = params.get('since');
    if (since) {
      cursorUpdatedAt = since;
      cursorId = '';
    }
  }

  const pageSize = Math.min(
    Math.max(Number.parseInt(params.get('limit') ?? '', 10) || PAGE_SIZE, 1),
    PAGE_SIZE,
  );

  let sql = `SELECT id, url_key, url, title, updated_at, deleted_at
    FROM bookmarks
    WHERE user_id = ? AND is_private = 0
      AND NOT EXISTS (
        SELECT 1 FROM bookmark_tags bt
        JOIN tags t ON t.id = bt.tag_id
        WHERE bt.bookmark_id = bookmarks.id AND t.user_id = ? AND t.is_private = 1
      )`;
  const bindArgs: unknown[] = [userId, userId];

  if (cursorUpdatedAt !== null) {
    sql += ` AND (updated_at > ? OR (updated_at = ? AND id > ?))`;
    bindArgs.push(cursorUpdatedAt, cursorUpdatedAt, cursorId);
  }

  sql += ` ORDER BY updated_at ASC, id ASC LIMIT ?`;
  bindArgs.push(pageSize);

  const rows = await ctx.env.DB.prepare(sql)
    .bind(...(bindArgs as (string | number)[]))
    .all<SyncPullRow>();

  const items = (rows.results ?? []).map((r) => ({
    id: r.id,
    urlKey: r.url_key,
    url: r.url,
    title: r.title ?? '',
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
  }));

  // Attach tag names in two queries rather than N (mirrors listBookmarks).
  const tagMap = await attachTags(
    ctx.env,
    userId,
    items.map((i) => i.id),
  );

  // Attach the derived primary-category path in one tag-tree load + one
  // chunked placement lookup rather than N upward walks (C4-1).
  const pathMap = await deriveCategoryPaths(
    ctx.env,
    userId,
    items.map((i) => i.id),
  );

  const payload = items.map((i) => ({
    ...i,
    tagNames: (tagMap.get(i.id) ?? []).map((t) => t.name),
    // A soft-deleted row's placement is moot — the browser removes the node.
    categoryPath: i.deletedAt === null ? (pathMap.get(i.id) ?? null) : null,
  }));

  const hasMore = payload.length === pageSize;
  const last = payload[payload.length - 1];
  const nextCursor =
    hasMore && last ? JSON.stringify({ updatedAt: last.updatedAt, id: last.id }) : null;

  return json({
    items: payload,
    cursor: nextCursor,
    hasMore,
  });
};

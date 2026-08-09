import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { json, notFound } from '../../../../_lib/http';
import { loadBookmark } from '../../../../_lib/db';
import { buildSnapshotStatus } from '../../../../_lib/snapshots';
import type { BookmarkSnapshotStatus } from '../../../../../shared/types';

/**
 * GET /api/bookmarks/:id/snapshot/status
 *
 * Lightweight endpoint for a single bookmark's latest snapshot. Returns the
 * served image URL, capture timestamp, and a staleness flag so each card can
 * poll independently without fetching the full monitor list.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const bookmark = await loadBookmark(ctx.env, userId, id);
  if (!bookmark) throw notFound('书签不存在');

  const status = buildSnapshotStatus(bookmark.snapshotKey);

  const body: BookmarkSnapshotStatus = {
    bookmarkId: bookmark.id,
    url: bookmark.url,
    title: bookmark.title,
    ...status,
  };

  return json(body);
};

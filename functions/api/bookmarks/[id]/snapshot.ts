import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequestCode, json, notFound } from '../../../_lib/http';
import {
  loadBookmark,
  loadSnapshotRetentionLimit,
  loadSnapshotState,
  updateBookmarkSnapshots,
} from '../../../_lib/db';
import {
  captureAndStoreBookmarkSnapshot,
  classifySnapshotError,
  deleteSnapshots,
  snapshotServePath,
} from '../../../_lib/snapshots';

/**
 * POST /api/bookmarks/:id/snapshot
 *
 * Generates a website snapshot for the bookmark's URL via the configured
 * provider (Cloudflare Browser Run, or an optional external screenshot API),
 * stores the image in R2, and persists the object key on the bookmark
 * (`snapshot_key`). The caller receives the served image path so the grid card
 * can swap the website preview to the first-party image.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const bookmark = await loadBookmark(ctx.env, userId, id);
  if (!bookmark) throw notFound('书签不存在');

  // Load current snapshot state for retention (the full list to keep/prune).
  const state = await loadSnapshotState(ctx.env, userId, id);
  if (!state) throw notFound('书签不存在');

  // Capture, store, and prune in one shared helper so the monitor endpoint can
  // reuse the exact same pipeline.
  const retentionLimit = await loadSnapshotRetentionLimit(ctx.env, userId);
  let stored: { key: string; keep: string[]; drop: string[] };
  try {
    stored = await captureAndStoreBookmarkSnapshot(ctx.env, {
      userId,
      bookmarkId: id,
      url: bookmark.url,
      existingKeys: state.snapshotKeys,
      retentionLimit,
    });
  } catch (e) {
    const { kind, message } = classifySnapshotError(e);
    if (kind === 'provider_error') throw badRequestCode('snapshot_provider_error', message);
    if (kind === 'too_large') throw badRequestCode('snapshot_too_large', message);
    if (kind === 'empty') throw badRequestCode('snapshot_empty', message);
    if (kind === 'r2_unavailable') throw badRequestCode('snapshot_storage_unavailable', message);
    if (kind === 'not_configured') throw badRequestCode('snapshot_not_configured', message);
    throw e;
  }

  try {
    await updateBookmarkSnapshots(ctx.env, userId, id, stored.key, stored.keep);
    if (stored.drop.length > 0) await deleteSnapshots(ctx.env, stored.drop);
  } catch {
    throw badRequestCode('snapshot_storage_unavailable', '图片存储服务暂不可用，请稍后重试');
  }

  return json({
    snapshotKey: stored.key,
    snapshotKeys: stored.keep,
    url: snapshotServePath(stored.key),
  });
};

import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { badRequest, json, notFound, readJson } from '../../../../_lib/http';
import { loadBookmark, loadSnapshotState, updateBookmarkSnapshots } from '../../../../_lib/db';
import { snapshotServePath } from '../../../../_lib/snapshots';

/**
 * POST /api/bookmarks/:id/snapshots/restore
 *
 * Time machine (O2): promotes a retained historical snapshot to be the
 * bookmark's current preview. This is a pure pointer swap on `snapshot_key` —
 * no R2 objects are touched, so it is idempotent and lossless: the version
 * that was current stays in the retained list and can be restored right back.
 *
 * The requested key must be present in the bookmark's retained
 * `snapshot_keys`; a key that was already pruned by retention (or fabricated)
 * is rejected with 400 rather than left pointing at a ghost object.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  // Ownership + privacy gate: loadBookmark applies PRIVATE_BOOKMARK_CLAUSE, so
  // private / category-private bookmarks surface as 404 exactly like elsewhere.
  const bookmark = await loadBookmark(ctx.env, userId, id);
  if (!bookmark) throw notFound('书签不存在');

  const body = await readJson<{ key?: unknown }>(ctx.request);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) throw badRequest('缺少快照标识');

  const state = await loadSnapshotState(ctx.env, userId, id);
  if (!state) throw notFound('书签不存在');

  if (!state.snapshotKeys.includes(key)) {
    throw badRequest('该快照版本不存在或已被清理');
  }

  // Idempotent: restoring the already-current version is a no-op success.
  if (state.snapshotKey !== key) {
    await updateBookmarkSnapshots(ctx.env, userId, id, key, state.snapshotKeys);
  }

  return json({
    bookmarkId: id,
    snapshotKey: key,
    snapshotKeys: state.snapshotKeys,
    url: snapshotServePath(key),
  });
};

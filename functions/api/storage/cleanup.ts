import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import {
  loadAllBookmarkSnapshotRefs,
  serializeSnapshotKeys,
} from '../../_lib/db';
import { reconcileBookmarkSnapshots } from '../../_lib/storage';

/**
 * POST /api/storage/cleanup
 *
 * Reconciles bookmark snapshot references against the real R2 objects and
 * removes "orphan" records — snapshot keys stored in `bookmarks.snapshot_keys`
 * (or `snapshot_key`) whose object no longer exists in the bucket (e.g. pruned
 * externally, or a dangling reference from an interrupted write).
 *
 * It never deletes an R2 object whose DB reference is valid; it only drops
 * DB references that have no backing object, so data is never lost here.
 *
 * Returns a report: how many bookmarks were scanned, how many orphan keys were
 * dropped, and how many bookmarks were rewritten.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  if (!ctx.env.SNAPSHOT_BUCKET) {
    return json({ error: 'snapshot_storage_unavailable', message: '快照存储未绑定' }, { status: 400 });
  }

  const refs = await loadAllBookmarkSnapshotRefs(ctx.env, userId);

  // Collect the unique set of keys referenced across all bookmarks so we only
  // issue one R2 HEAD per distinct object.
  const allKeys = new Set<string>();
  for (const r of refs) {
    if (r.latestKey) allKeys.add(r.latestKey);
    for (const k of r.snapshotKeys) allKeys.add(k);
  }

  // Ask R2 which of those keys still exist (head does not download the body).
  const existing = new Set<string>();
  for (const key of allKeys) {
    const obj = await ctx.env.SNAPSHOT_BUCKET.head(key);
    if (obj) existing.add(key);
  }

  let scanned = 0;
  let rewritten = 0;
  let droppedKeys = 0;
  const dropped: string[] = [];

  for (const ref of refs) {
    scanned++;
    const { keepKeys, dropKeys, newLatestKey } = reconcileBookmarkSnapshots(
      ref.latestKey,
      ref.snapshotKeys,
      existing,
    );
    if (dropKeys.length === 0) continue;

    // Rewrite the bookmark's snapshot columns, dropping the orphan references.
    await ctx.env.DB.prepare(
      `UPDATE bookmarks
          SET snapshot_key = ?, snapshot_keys = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`,
    )
      .bind(newLatestKey, serializeSnapshotKeys(keepKeys), ref.id, userId)
      .run();

    rewritten++;
    droppedKeys += dropKeys.length;
    dropped.push(...dropKeys);
  }

  return json({
    scanned,
    rewritten,
    droppedKeys,
    dropped: dropped.slice(0, 100), // cap the detail list for the response
  });
};

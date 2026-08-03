import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { json, notFound } from '../../../_lib/http';
import { loadSnapshotState } from '../../../_lib/db';
import { snapshotServePath, snapshotTimestamp, sortSnapshotsNewestFirst } from '../../../_lib/snapshots';

/**
 * GET /api/bookmarks/:id/snapshots
 *
 * Returns a bookmark's full retained snapshot history (newest first), each as
 * a key + an unauthenticated serve URL the detail panel can render/switch. The
 * retention policy caps how many entries can exist; older captures are pruned
 * automatically, so this list is bounded by the user's setting.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const state = await loadSnapshotState(ctx.env, userId, id);
  if (!state) throw notFound('书签不存在');

  // Newest first for the detail panel's default (most recent on the left).
  const keys = sortSnapshotsNewestFirst(state.snapshotKeys);

  return json({
    bookmarkId: id,
    snapshots: keys.map((key) => ({
      key,
      url: snapshotServePath(key),
      isLatest: key === state.snapshotKey,
      capturedAt: snapshotTimestamp(key) ? new Date(snapshotTimestamp(key)).toISOString() : null,
    })),
    count: keys.length,
  });
};

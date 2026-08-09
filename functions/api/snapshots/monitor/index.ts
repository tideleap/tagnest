import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequestCode, json, notFound, readJson } from '../../../_lib/http';
import {
  listBookmarksWithSnapshots,
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
  snapshotTimestamp,
} from '../../../_lib/snapshots';
import type { SnapshotMonitorItem, SnapshotMonitorStatus } from '../../../../shared/types';

const MONITOR_LIMIT = 6;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

interface SnapshotStatusExtras {
  snapshotUrl: string;
  capturedAt: string | null;
  isStale: boolean;
}

function toMonitorItem(row: Awaited<ReturnType<typeof listBookmarksWithSnapshots>>[number]): SnapshotMonitorItem & SnapshotStatusExtras {
  const ts = snapshotTimestamp(row.snapshotKey);
  return {
    bookmarkId: row.id,
    title: row.title,
    url: row.url,
    snapshotKey: row.snapshotKey,
    snapshotUrl: snapshotServePath(row.snapshotKey),
    capturedAt: ts ? new Date(ts).toISOString() : null,
    isStale: ts ? Date.now() - ts > STALE_THRESHOLD_MS : true,
  };
}

/**
 * GET /api/snapshots/monitor
 *
 * Returns the user's currently-monitored bookmarks: the top N live bookmarks
 * that already have a snapshot, sorted by engagement (visits) then recency.
 * Each item carries the latest snapshot URL and a staleness flag so the UI can
 * show whether the image is fresh or waiting for the next refresh cycle.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const rows = await listBookmarksWithSnapshots(ctx.env, userId, MONITOR_LIMIT);

  const status: SnapshotMonitorStatus = {
    items: rows.map(toMonitorItem),
    limit: MONITOR_LIMIT,
    refreshedAt: new Date().toISOString(),
  };

  return json(status);
};

/**
 * POST /api/snapshots/monitor
 *
 * Refreshes one bookmark's snapshot. The body may specify `bookmarkId`; when
 * omitted, the endpoint refreshes the bookmark whose latest snapshot is oldest
 * (round-robin style). This keeps a single HTTP request short — screenshots can
 * take seconds — while still giving the monitor an automatic "rotate and refresh"
 * capability.
 *
 * Returns the refreshed item so the UI can swap the image immediately.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  if (!ctx.env.SNAPSHOT_BUCKET) {
    throw badRequestCode('snapshot_not_configured', '网站快照存储未配置，无法生成预览图');
  }

  const body = await readJson<{ bookmarkId?: unknown }>(ctx.request);
  const requestedId = typeof body.bookmarkId === 'string' ? body.bookmarkId : null;

  let targetId: string;
  let row: Awaited<ReturnType<typeof listBookmarksWithSnapshots>>[number] | undefined;

  if (requestedId) {
    targetId = requestedId;
    const bookmark = await loadBookmark(ctx.env, userId, targetId);
    if (!bookmark) throw notFound('书签不存在');
    if (!bookmark.snapshotKey) {
      throw badRequestCode('snapshot_not_found', '该书签还没有快照，无法刷新');
    }
    row = {
      id: bookmark.id,
      url: bookmark.url,
      title: bookmark.title,
      snapshotKey: bookmark.snapshotKey,
      snapshotKeys: bookmark.snapshotKeys,
      visitCount: bookmark.visitCount,
      lastVisitedAt: bookmark.lastVisitedAt,
    };
  } else {
    const rows = await listBookmarksWithSnapshots(ctx.env, userId, MONITOR_LIMIT);
    if (rows.length === 0) {
      throw badRequestCode('snapshot_not_found', '没有可监测的书签快照');
    }
    // Pick the row whose latest snapshot is oldest, so each auto-refresh walks
    // through the monitor set rather than hammering the same favourite.
    row = rows.reduce((oldest, current) => {
      const oldestTs = snapshotTimestamp(oldest.snapshotKey);
      const currentTs = snapshotTimestamp(current.snapshotKey);
      return currentTs < oldestTs ? current : oldest;
    });
    targetId = row.id;
  }

  const state = await loadSnapshotState(ctx.env, userId, targetId);
  if (!state) throw notFound('书签不存在');

  const retentionLimit = await loadSnapshotRetentionLimit(ctx.env, userId);

  let stored: { key: string; keep: string[]; drop: string[] };
  try {
    stored = await captureAndStoreBookmarkSnapshot(ctx.env, {
      userId,
      bookmarkId: targetId,
      url: row.url,
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
    await updateBookmarkSnapshots(ctx.env, userId, targetId, stored.key, stored.keep);
    if (stored.drop.length > 0) await deleteSnapshots(ctx.env, stored.drop);
  } catch {
    throw badRequestCode('snapshot_storage_unavailable', '图片存储服务暂不可用，请稍后重试');
  }

  return json({
    item: {
      bookmarkId: targetId,
      title: row.title,
      url: row.url,
      snapshotKey: stored.key,
      snapshotUrl: snapshotServePath(stored.key),
      capturedAt: new Date().toISOString(),
      isStale: false,
    } satisfies SnapshotMonitorItem & SnapshotStatusExtras,
    refreshedAt: new Date().toISOString(),
  });
};

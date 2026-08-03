import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequestCode, json, notFound } from '../../../_lib/http';
import { nowIso } from '../../../_lib/ids';
import { loadBookmark } from '../../../_lib/db';
import {
  classifySnapshotError,
  fetchSnapshotFromApi,
  putSnapshot,
  snapshotServePath,
} from '../../../_lib/snapshots';

/**
 * POST /api/bookmarks/:id/snapshot
 *
 * Generates a website snapshot for the bookmark's URL via the configured
 * third-party screenshot API, stores the image in R2, and persists the object
 * key on the bookmark (`snapshot_key`). The caller receives the served image
 * path so the grid card can swap the website preview to the first-party image.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const bookmark = await loadBookmark(ctx.env, userId, id);
  if (!bookmark) throw notFound('书签不存在');

  // SNAPSHOT_API_URL is optional: when unset, the snapshot lib falls back to a
  // built-in free web-screenshot provider (see DEFAULT_SNAPSHOT_API_URL). Only
  // the R2 bucket is required here — a served image needs somewhere to live.
  if (!ctx.env.SNAPSHOT_BUCKET) {
    throw badRequestCode('snapshot_not_configured', '网站快照存储未配置，无法生成预览图');
  }

  let bytes: Uint8Array;
  let contentType: string;
  try {
    ({ bytes, contentType } = await fetchSnapshotFromApi(bookmark.url, {
      apiUrl: ctx.env.SNAPSHOT_API_URL,
      apiKey: ctx.env.SNAPSHOT_API_KEY,
    }));
  } catch (e) {
    const { kind, message } = classifySnapshotError(e);
    // Provider / size / emptiness failures are non-fatal to the bookmark —
    // surface a clear, non-retriable mapping instead of a generic 500.
    if (kind === 'provider_error') {
      throw badRequestCode('snapshot_provider_error', message);
    }
    if (kind === 'too_large') {
      throw badRequestCode('snapshot_too_large', message);
    }
    if (kind === 'empty') {
      throw badRequestCode('snapshot_empty', message);
    }
    if (kind === 'r2_unavailable') {
      throw badRequestCode('snapshot_storage_unavailable', message);
    }
    throw e;
  }

  let key: string;
  try {
    key = await putSnapshot(ctx.env, userId, id, bytes, contentType);
  } catch {
    throw badRequestCode('snapshot_storage_unavailable', '图片存储服务暂不可用，请稍后重试');
  }

  await ctx.env.DB.prepare(
    `UPDATE bookmarks SET snapshot_key = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(key, nowIso(), id, userId)
    .run();

  return json({
    snapshotKey: key,
    url: snapshotServePath(userId, id),
  });
};

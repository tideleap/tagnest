import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequestCode, json, notFound } from '../../../_lib/http';
import { nowIso } from '../../../_lib/ids';
import { loadBookmark } from '../../../_lib/db';
import {
  captureWithBrowserRun,
  classifySnapshotError,
  fetchSnapshotFromApi,
  putSnapshot,
  resolveSnapshotProvider,
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

  // The R2 bucket is required — a served image needs somewhere to live. The
  // capture provider (Browser Run vs external API) is picked separately below.
  if (!ctx.env.SNAPSHOT_BUCKET) {
    throw badRequestCode('snapshot_not_configured', '网站快照存储未配置，无法生成预览图');
  }

  const provider = resolveSnapshotProvider(ctx.env);
  if (provider === 'none') {
    throw badRequestCode('snapshot_not_configured', '未配置截图能力（需启用 Cloudflare Browser Run 或设置 SNAPSHOT_API_URL）');
  }

  let bytes: Uint8Array;
  let contentType: string;
  try {
    if (provider === 'external') {
      ({ bytes, contentType } = await fetchSnapshotFromApi(bookmark.url, {
        apiUrl: ctx.env.SNAPSHOT_API_URL,
        apiKey: ctx.env.SNAPSHOT_API_KEY,
      }));
    } else {
      ({ bytes, contentType } = await captureWithBrowserRun(ctx.env, bookmark.url));
    }
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
    if (kind === 'not_configured') {
      throw badRequestCode('snapshot_not_configured', message);
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

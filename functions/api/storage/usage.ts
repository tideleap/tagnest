import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import { fetchStorageUsage, formatBytes, STORAGE_QUOTA_BYTES } from '../../_lib/storage';

/**
 * GET /api/storage/usage
 *
 * Reports the account's R2 storage usage for website snapshots. `tagnest-media`
 * only stores snapshot objects under `snapshots/{userId}/`, so the usage below
 * is computed by paginating `list({ prefix: 'snapshots/' })` and summing object
 * sizes. Cover images are remote URLs and never counted here.
 *
 * Response is machine-readable bytes + a ready-to-display human string; the
 * front end renders "当前使用 X.XX GB / 无限制".
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  requireUserId(ctx);

  const usage = await fetchStorageUsage(ctx.env, {});

  const quotaBytes = STORAGE_QUOTA_BYTES;
  const quotaFmt = quotaBytes === Number.POSITIVE_INFINITY ? '无限制' : formatBytes(quotaBytes);

  return json({
    totalBytes: usage.totalBytes,
    snapshotBytes: usage.snapshotBytes,
    snapshotCount: usage.snapshotCount,
    totalCount: usage.totalCount,
    otherCount: usage.otherCount,
    otherBytes: usage.otherBytes,
    quotaBytes,
    quotaFmt,
    // Pre-formatted alongside the raw byte count, same contract as `quotaFmt`:
    // the byte figure is what users actually care about when deciding whether
    // to prune snapshots, and the object count alone cannot convey it.
    snapshotFmt: formatBytes(usage.snapshotBytes),
    // Human-friendly single-line string for the section header:
    display: `当前使用 ${formatBytes(usage.totalBytes)} / ${quotaFmt}`,
  });
};

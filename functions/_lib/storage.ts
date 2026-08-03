import type { Env } from './env';

/**
 * R2 storage management helpers.
 *
 * The `tagnest-media` bucket holds website snapshots only — cover images are
 * remote third-party URLs, never uploaded here. Storage usage therefore equals
 * the total size of the user's snapshot objects under the `snapshots/{userId}/`
 * prefix. This module exposes:
 *
 *   - `fetchStorageUsage()`     — page through R2 `list({prefix})` and sum sizes.
 *   - `formatBytes()`           — human-readable size (pure, unit-testable).
 *   - `collectBookmarkSnapshotKeys()` / `cleanupOrphanSnapshots()` — reconcile
 *     DB snapshot references against the actual R2 objects.
 *
 * Everything is written against the workers-types `R2Bucket` surface (list,
 * head, delete) so the number-crunching is pure and unit-testable with an
 * in-memory stub.
 */

/** The R2 "unlimited" quota is represented as this cap for display. */
export const STORAGE_QUOTA_BYTES = Number.POSITIVE_INFINITY;

/**
 * Human-readable size with SI units, capped at 2 decimals — e.g. `1.23 GB`,
 * `456 KB`, `12 B`. Pure function, used by both the API and its tests.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIdx = -1;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${units[unitIdx]}`;
}

/**
 * Aggregates R2 objects into a usage summary. Returns per-prefix breakdown and
 * totals so callers can show "snapshots X, total Y".
 */
export interface R2Usage {
  /** Snapshot objects under `snapshots/{userId}/`. */
  snapshotCount: number;
  snapshotBytes: number;
  /** All objects counted (currently only snapshots; kept for forward-compat). */
  totalCount: number;
  totalBytes: number;
  /** Objects/bytes that do not look like snapshots (metadata/other prefixes). */
  otherCount: number;
  otherBytes: number;
}

/**
 * Pages through the bucket with `list({ prefix })`, summing object sizes.
 * `list` is paginated (truncated + cursor), so we keep following the cursor.
 * Uses `head`-free enumeration — no body is downloaded.
 */
export async function fetchStorageUsage(
  env: Pick<Env, 'SNAPSHOT_BUCKET'>,
  opts: { userId?: string; prefix?: string } = {},
): Promise<R2Usage> {
  const bucket = env.SNAPSHOT_BUCKET;
  if (!bucket) {
    return { snapshotCount: 0, snapshotBytes: 0, totalCount: 0, totalBytes: 0, otherCount: 0, otherBytes: 0 };
  }

  // What to LIST: `prefix` wins; otherwise scope to the user's folder, or the
  // whole snapshot namespace when no user is given (the "global" view).
  const listPrefix = opts.prefix ?? (opts.userId ? `snapshots/${opts.userId}/` : 'snapshots/');
  // What counts as a SNAPSHOT during classification. Distinct from listPrefix so
  // a broad listing (e.g. prefix:'') can still separate snapshots from "other".
  const snapshotPrefix = opts.userId ? `snapshots/${opts.userId}/` : 'snapshots/';

  const usage: R2Usage = {
    snapshotCount: 0,
    snapshotBytes: 0,
    totalCount: 0,
    totalBytes: 0,
    otherCount: 0,
    otherBytes: 0,
  };

  let cursor: string | undefined;
  do {
    const page: R2Objects = await bucket.list({ prefix: listPrefix, cursor });
    for (const obj of page.objects) {
      usage.totalCount++;
      usage.totalBytes += obj.size;
      if (obj.key.startsWith(snapshotPrefix)) {
        usage.snapshotCount++;
        usage.snapshotBytes += obj.size;
      } else {
        usage.otherCount++;
        usage.otherBytes += obj.size;
      }
    }
    cursor = (page as { truncated: true } | { truncated: false }).truncated
      ? (page as { truncated: true; cursor: string }).cursor
      : undefined;
  } while (cursor);

  return usage;
}

/** Snapshot key that a given DB value represents (latest vs history). */
export interface SnapshotRef {
  markLatest: boolean; // true → the key is the bookmark's `snapshot_key`
  key: string;
}

/**
 * Pure version of the orphan cleanup decision for a single bookmark: given its
 * DB-stored latest snapshot key + retained key list, and the set of object keys
 * that actually exist in R2, returns which keys to remove and the surviving
 * latest key.
 *
 * A DB key is "orphaned" when the R2 object no longer exists (already pruned
 * manually, or a dangling reference). Returns null keys to keep, drops the
 * orphans, and the new latest for the bookmark.
 */
export function reconcileBookmarkSnapshots(
  latestKey: string | null,
  snapshotKeys: string[],
  objectsExist: Set<string>,
): { keepKeys: string[]; dropKeys: string[]; newLatestKey: string | null } {
  const drop = new Set<string>();
  const keep: string[] = [];

  for (const key of snapshotKeys) {
    if (objectsExist.has(key)) keep.push(key);
    else drop.add(key);
  }

  let newLatest = latestKey;
  if (latestKey && !objectsExist.has(latestKey)) {
    // Latest reference is gone; fall back to the newest surviving kept key.
    newLatest = keep.length > 0 ? keep[keep.length - 1] : null;
    drop.add(latestKey);
  }

  return { keepKeys: keep, dropKeys: [...drop], newLatestKey: newLatest };
}

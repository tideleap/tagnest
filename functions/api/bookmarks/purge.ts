import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json, readJson } from '../../_lib/http';
import { parseSnapshotKeys, D1_IN_CHUNK } from '../../_lib/db';
import { deleteSnapshots } from '../../_lib/snapshots';
import { readIds } from './trash';

/**
 * Irreversible delete.
 *
 * Scoped to `deleted_at IS NOT NULL` so a live bookmark can never be destroyed
 * by a stray call — everything must pass through the trash first.
 *
 * Hard-deleting a bookmark also drops its retained R2 snapshot objects. Without
 * this the images would orphan: `storage/cleanup` only prunes DB references
 * whose R2 object is missing (the other direction), so a purged bookmark's
 * snapshots would otherwise sit in the bucket forever, still counted in usage
 * and costing storage. This is best-effort — if R2 is unbound the DB delete
 * still happens.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  // Emptying the trash wholesale, rather than by id list.
  if (body.all === true) {
    const before = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ? AND deleted_at IS NOT NULL`,
    )
      .bind(userId)
      .first<{ c: number }>();
    await purgeSnapshotsForIds(ctx.env, userId, null);
    await ctx.env.DB.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND deleted_at IS NOT NULL`)
      .bind(userId)
      .run();
    return json({ deleted: before?.c ?? 0 });
  }

  const ids = readIds(body);
  const placeholders = ids.map(() => '?').join(',');
  const before = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookmarks
      WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${placeholders})`,
  )
    .bind(userId, ...ids)
    .first<{ c: number }>();

  await purgeSnapshotsForIds(ctx.env, userId, ids);

  await ctx.env.DB.prepare(
    `DELETE FROM bookmarks
      WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${placeholders})`,
  )
    .bind(userId, ...ids)
    .run();

  return json({ deleted: before?.c ?? 0 });
};

/**
 * Deletes the R2 snapshot objects referenced by a set of bookmarks before they
 * are hard-deleted. `ids === null` means the whole (trashed) library.
 */
async function purgeSnapshotsForIds(
  env: Env,
  userId: string,
  ids: string[] | null,
): Promise<void> {
  const bucket = env.SNAPSHOT_BUCKET;
  if (!bucket) return; // no R2 bound → nothing to clean

  const db = env.DB;
  const allKeys: string[] = [];
  if (ids === null) {
    const rows = await db
      .prepare(
        `SELECT snapshot_key, snapshot_keys FROM bookmarks WHERE user_id = ? AND deleted_at IS NOT NULL`,
      )
      .bind(userId)
      .all<{ snapshot_key: string | null; snapshot_keys: string | null }>();
    for (const r of rows.results) {
      if (r.snapshot_key) allKeys.push(r.snapshot_key);
      for (const k of parseSnapshotKeys(r.snapshot_keys)) allKeys.push(k);
    }
  } else {
    for (const idChunk of chunk(ids, D1_IN_CHUNK)) {
      const sql = `SELECT snapshot_key, snapshot_keys FROM bookmarks
                    WHERE user_id = ? AND deleted_at IS NOT NULL
                      AND id IN (${idChunk.map(() => '?').join(',')})`;
      const rows = await db
        .prepare(sql)
        .bind(userId, ...idChunk)
        .all<{ snapshot_key: string | null; snapshot_keys: string | null }>();
      for (const r of rows.results) {
        if (r.snapshot_key) allKeys.push(r.snapshot_key);
        for (const k of parseSnapshotKeys(r.snapshot_keys)) allKeys.push(k);
      }
    }
  }

  if (allKeys.length > 0) await deleteSnapshots({ SNAPSHOT_BUCKET: bucket }, allKeys);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

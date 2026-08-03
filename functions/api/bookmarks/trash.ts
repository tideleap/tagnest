import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { D1_IN_CHUNK } from '../../_lib/db';

/**
 * Shared by the bulk endpoints; caps the batch at D1's per-statement bound-param
 * limit (99), so a single `IN (...)` never overflows the 100-param ceiling.
 * Keeps the accumulation loop below the limit: any earlier slice blindly added
 * up to 500 ids, which would fatally 500 on D1.
 */
export function readIds(body: Record<string, unknown>): string[] {
  const raw = body.ids;
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('未选择任何书签');
  const ids = [...new Set(raw.map(String).filter(Boolean))].slice(0, D1_IN_CHUNK);
  if (ids.length === 0) throw badRequest('未选择任何书签');
  return ids;
}

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const ids = readIds(await readJson(ctx.request));
  const ts = nowIso();
  const placeholders = ids.map(() => '?').join(',');

  // meta.changes is unreliable here: the bookmarks_fts trigram triggers also
  // touch the FTS index on every UPDATE, inflating the reported count. We
  // measure the real number of affected rows from the same WHERE clause
  // instead, which is exact and trigger-independent.
  const before = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookmarks
      WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
  )
    .bind(userId, ...ids)
    .first<{ c: number }>();

  await ctx.env.DB.prepare(
    `UPDATE bookmarks SET deleted_at = ?, updated_at = ?
      WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
  )
    .bind(ts, ts, userId, ...ids)
    .run();

  return json({ moved: before?.c ?? 0 });
};

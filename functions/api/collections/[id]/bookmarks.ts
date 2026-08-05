import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, notFound, readJson } from '../../../_lib/http';
import { nowIso } from '../../../_lib/ids';
import { getCollectionRow } from '../../../_lib/collections';

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const collectionId = String(ctx.params.id);

  const c = await getCollectionRow(ctx.env, userId, collectionId);
  if (!c) throw notFound('集合不存在');

  const body = await readJson<{ bookmarkId?: string }>(ctx.request);
  const bookmarkId = String(body.bookmarkId ?? '');
  if (!bookmarkId) throw badRequest('缺少 bookmarkId');

  // Membership is only meaningful for bookmarks the user owns and hasn't trashed.
  const bm = await ctx.env.DB.prepare(
    `SELECT id FROM bookmarks WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`,
  )
    .bind(bookmarkId, userId)
    .first<{ id: string }>();
  if (!bm) throw notFound('书签不存在');

  // Append at the end of the manual order.
  const maxRow = await ctx.env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) AS m FROM collection_bookmarks WHERE collection_id = ?`,
  )
    .bind(collectionId)
    .first<{ m: number }>();
  const position = (maxRow?.m ?? -1) + 1;

  await ctx.env.DB.prepare(
    `INSERT OR IGNORE INTO collection_bookmarks (collection_id, bookmark_id, position, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(collectionId, bookmarkId, position, nowIso())
    .run();

  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const collectionId = String(ctx.params.id);

  const c = await getCollectionRow(ctx.env, userId, collectionId);
  if (!c) throw notFound('集合不存在');

  const bookmarkId = new URL(ctx.request.url).searchParams.get('bookmarkId') ?? '';
  if (!bookmarkId) throw badRequest('缺少 bookmarkId');

  await ctx.env.DB.prepare(
    `DELETE FROM collection_bookmarks WHERE collection_id = ? AND bookmark_id = ?`,
  )
    .bind(collectionId, bookmarkId)
    .run();

  return new Response(null, { status: 204 });
};

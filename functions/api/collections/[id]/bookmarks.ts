import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, conflict, json, notFound, readJson } from '../../../_lib/http';
import { nowIso } from '../../../_lib/ids';
import { getCollectionRow } from '../../../_lib/collections';
import { PRIVATE_BOOKMARK_CLAUSE } from '../../../_lib/db';

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const collectionId = String(ctx.params.id);

  const c = await getCollectionRow(ctx.env, userId, collectionId);
  if (!c) throw notFound('集合不存在');

  // Smart collections populate their members from a live query — manual add is
  // meaningless and would silently diverge, so surface a clear conflict.
  if ((c.kind as string) === 'smart') {
    throw conflict('智能集合成员由搜索自动维护', { kind: '智能集合不可手动添加书签' });
  }

  const body = await readJson<{ bookmarkId?: string }>(ctx.request);
  const bookmarkId = String(body.bookmarkId ?? '');
  if (!bookmarkId) throw badRequest('缺少 bookmarkId');

  // Membership is only meaningful for bookmarks the user owns, hasn't trashed,
  // and that are not private (vaulted or category-private) — a collection is a
  // shareable aggregate surface, so private content must never enter it.
  const bm = await ctx.env.DB.prepare(
    `SELECT id FROM bookmarks b
      WHERE b.id = ? AND b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
      LIMIT 1`,
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

  if ((c.kind as string) === 'smart') {
    throw conflict('智能集合成员由搜索自动维护', { kind: '智能集合不可手动移除书签' });
  }

  const bookmarkId = new URL(ctx.request.url).searchParams.get('bookmarkId') ?? '';
  if (!bookmarkId) throw badRequest('缺少 bookmarkId');

  await ctx.env.DB.prepare(
    `DELETE FROM collection_bookmarks WHERE collection_id = ? AND bookmark_id = ?`,
  )
    .bind(collectionId, bookmarkId)
    .run();

  return new Response(null, { status: 204 });
};

import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, notFound, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { getCollectionRow, mapCollection, mapCollectionBookmark } from '../../_lib/collections';
import { TAG_COLOR_COUNT } from '../../../shared/types';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const c = await getCollectionRow(ctx.env, userId, id);
  if (!c) throw notFound('集合不存在');

  // Only non-trashed bookmarks the user owns show up in the detail view.
  const bookmarks = await ctx.env.DB.prepare(
    `SELECT b.id, b.url, b.title, b.favicon_url
       FROM collection_bookmarks cb
       JOIN bookmarks b ON b.id = cb.bookmark_id AND b.deleted_at IS NULL AND b.user_id = ?
      WHERE cb.collection_id = ?
      ORDER BY cb.position, b.created_at DESC`,
  )
    .bind(userId, id)
    .all<Record<string, unknown>>();

  return json({
    collection: mapCollection(c),
    bookmarks: bookmarks.results.map(mapCollectionBookmark),
  });
};

export const onRequestPut: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const c = await getCollectionRow(ctx.env, userId, id);
  if (!c) throw notFound('集合不存在');

  const body = await readJson<{ name?: string; colorIndex?: number }>(ctx.request);
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('请输入集合名称', { name: '请输入集合名称' });
  if (name.length > 60) throw badRequest('集合名称过长', { name: '集合名称过长' });

  const dup = await ctx.env.DB.prepare(
    `SELECT id FROM collections WHERE user_id = ? AND name COLLATE NOCASE = ? AND id != ? LIMIT 1`,
  )
    .bind(userId, name, id)
    .first<{ id: string }>();
  if (dup) throw conflict('集合已存在', { name: '集合已存在' });

  const colorIndex =
    Number.isInteger(body.colorIndex) && (body.colorIndex as number) >= 0
      ? (body.colorIndex as number) % TAG_COLOR_COUNT
      : Number(c.color_index ?? 0);

  const ts = nowIso();
  await ctx.env.DB.prepare(
    `UPDATE collections SET name = ?, color_index = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(name, colorIndex, ts, id, userId)
    .run();

  return json(mapCollection({ ...c, name, color_index: colorIndex, updated_at: ts }));
};

export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const c = await getCollectionRow(ctx.env, userId, id);
  if (!c) throw notFound('集合不存在');

  // Cascade: dropping a collection clears its membership too.
  await ctx.env.DB.prepare(`DELETE FROM collection_bookmarks WHERE collection_id = ?`)
    .bind(id)
    .run();
  await ctx.env.DB.prepare(`DELETE FROM collections WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();

  return new Response(null, { status: 204 });
};

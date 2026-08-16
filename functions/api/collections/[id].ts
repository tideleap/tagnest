import type { CollectionKind } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, notFound, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import {
  getCollectionRow,
  mapCollection,
  mapCollectionBookmark,
  resolveSmartCollectionMembers,
  serializeSavedSearchQuery,
  validateSavedSearchQuery,
} from '../../_lib/collections';
import { PRIVATE_BOOKMARK_CLAUSE } from '../../_lib/db';
import { TAG_COLOR_COUNT } from '../../../shared/types';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const c = await getCollectionRow(ctx.env, userId, id);
  if (!c) throw notFound('集合不存在');

  const collection = mapCollection(c);

  // Smart collections resolve their members live from the saved query; manual
  // collections read their stored membership. Both honor privacy filtering.
  if (collection.kind === 'smart' && collection.query) {
    const page = await resolveSmartCollectionMembers(ctx.env, userId, collection.query, {
      limit: 100,
    });
    collection.count = page.total;
    return json({
      collection,
      bookmarks: page.items.map(mapCollectionBookmark),
    });
  }

  // Only non-trashed, non-private bookmarks the user owns show up in the
  // detail view. PRIVATE_BOOKMARK_CLAUSE keeps both vaulted and
  // category-private bookmarks out of this aggregate surface.
  const bookmarks = await ctx.env.DB.prepare(
    `SELECT b.id, b.url, b.title, b.favicon_url
       FROM collection_bookmarks cb
       JOIN bookmarks b ON b.id = cb.bookmark_id AND b.deleted_at IS NULL AND b.user_id = ?
            AND ${PRIVATE_BOOKMARK_CLAUSE}
      WHERE cb.collection_id = ?
      ORDER BY cb.position, b.created_at DESC`,
  )
    .bind(userId, id)
    .all<Record<string, unknown>>();

  return json({
    collection,
    bookmarks: bookmarks.results.map(mapCollectionBookmark),
  });
};

export const onRequestPut: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const c = await getCollectionRow(ctx.env, userId, id);
  if (!c) throw notFound('集合不存在');

  const body = await readJson<{ name?: string; colorIndex?: number; query?: unknown }>(ctx.request);
  const currentKind = (c.kind as CollectionKind) ?? 'manual';

  // `kind` is immutable: a manual collection stays curated, a smart one stays
  // query-driven. Flipping it would change membership semantics mid-flight, so
  // we require a delete+recreate instead.
  if ('kind' in body && body.kind !== undefined && body.kind !== currentKind) {
    throw badRequest('集合类型不可更改', { kind: '集合类型（手动/智能）不可更改' });
  }

  // `name` is optional on PUT: omit it to keep the current name (e.g. when only
  // editing a smart collection's query). An explicitly empty name is still 400.
  const rawName =
    body.name !== undefined ? String(body.name ?? '').trim().replace(/\s+/g, ' ') : null;
  if (rawName !== null && rawName === '') {
    throw badRequest('请输入集合名称', { name: '请输入集合名称' });
  }
  if (rawName !== null && rawName.length > 60) {
    throw badRequest('集合名称过长', { name: '集合名称过长' });
  }
  const name = rawName ?? (c.name as string);

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

  // Only smart collections may carry a query; editing it re-validates and
  // clamps. Manual collections ignore any `query` in the body.
  let newQuery: string | null = (c.query as string | null) ?? null;
  if (currentKind === 'smart') {
    if (body.query === null) {
      newQuery = null;
    } else if (body.query !== undefined) {
      newQuery = serializeSavedSearchQuery(validateSavedSearchQuery(body.query));
    }
  }

  const ts = nowIso();
  await ctx.env.DB.prepare(
    `UPDATE collections SET name = ?, color_index = ?, query = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(name, colorIndex, newQuery, ts, id, userId)
    .run();

  return json(mapCollection({ ...c, name, color_index: colorIndex, kind: currentKind, query: newQuery, updated_at: ts }));
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

import type { BookmarkScope, BookmarkSort } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, readJson } from '../../_lib/http';
import { newId, nowIso } from '../../_lib/ids';
import { ensureTags, listBookmarks, loadBookmark, setBookmarkTags } from '../../_lib/db';
import { canonicalUrl, faviconFor, titleFallback, urlKey } from '../../_lib/urlkey';
import { createLogger } from '../../_lib/logger';
import { enrichBookmark } from '../../_lib/ai';

const SCOPES: BookmarkScope[] = ['inbox', 'all', 'favorites', 'archive', 'trash'];
const SORTS: BookmarkSort[] = [
  'created_desc',
  'created_asc',
  'updated_desc',
  'title_asc',
  'visits_desc',
  'manual',
];

const MAX_LIMIT = 100;

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const params = new URL(ctx.request.url).searchParams;

  const scope = params.get('scope') as BookmarkScope | null;
  const sort = params.get('sort') as BookmarkSort | null;

  const rawLimit = Number.parseInt(params.get('limit') ?? '40', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : 40;

  const page = await listBookmarks(ctx.env, {
    userId,
    scope: scope && SCOPES.includes(scope) ? scope : 'all',
    q: params.get('q')?.trim().slice(0, 200) || null,
    tagIds: (params.get('tagIds') ?? '').split(',').filter(Boolean).slice(0, 20),
    matchAllTags: params.get('matchAllTags') === 'true',
    sort: sort && SORTS.includes(sort) ? sort : 'created_desc',
    cursor: params.get('cursor'),
    limit,
  });

  return json(page);
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{
    url?: string;
    title?: string;
    description?: string | null;
    note?: string | null;
    faviconUrl?: string | null;
    coverUrl?: string | null;
    isFavorite?: boolean;
    isArchived?: boolean;
    tagNames?: string[];
  }>(ctx.request);

  const url = canonicalUrl(typeof body.url === 'string' ? body.url : '');
  if (!url) throw badRequest('请输入合法的网址', { url: '网址格式不正确' });

  const key = urlKey(url);

  // A repeat save is almost always an accident (re-clicking the extension, a
  // double submit). Surfacing the existing record beats silently duplicating.
  const dupe = await ctx.env.DB.prepare(
    `SELECT id FROM bookmarks WHERE user_id = ? AND url_key = ? AND deleted_at IS NULL LIMIT 1`,
  )
    .bind(userId, key)
    .first<{ id: string }>();

  if (dupe) throw conflict('该网址已在书签库中', { id: dupe.id });

  const id = newId();
  const ts = nowIso();
  const title = (typeof body.title === 'string' && body.title.trim()) || titleFallback(url);

  await ctx.env.DB.prepare(
    `INSERT INTO bookmarks
       (id, user_id, url, url_key, title, description, favicon_url, cover_url, note,
        ai_summary, is_favorite, is_archived, visit_count, last_visited_at,
        created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL, ?, ?, NULL)`,
  )
    .bind(
      id,
      userId,
      url,
      key,
      title.slice(0, 300),
      body.description ? String(body.description).slice(0, 2000) : null,
      body.faviconUrl ? String(body.faviconUrl).slice(0, 500) : faviconFor(url),
      body.coverUrl ? String(body.coverUrl).slice(0, 500) : null,
      body.note ? String(body.note).slice(0, 20000) : null,
      body.isFavorite ? 1 : 0,
      body.isArchived ? 1 : 0,
      ts,
      ts,
    )
    .run();

  if (Array.isArray(body.tagNames) && body.tagNames.length > 0) {
    const { ids } = await ensureTags(ctx.env, userId, body.tagNames.slice(0, 30));
    await setBookmarkTags(ctx.env, id, ids);
  }

  const created = await loadBookmark(ctx.env, userId, id);
  createLogger(ctx.env).info('bookmark.create', { userId });

  // AI enrichment runs after the response is on its way. Saving a bookmark is
  // a one-second action and must stay that way; the summary and suggested tags
  // land on the next read. No-op unless the user configured a provider.
  ctx.waitUntil(
    enrichBookmark(ctx.env, userId, id, {
      url,
      title: created?.title ?? title,
      description: created?.description ?? null,
    }),
  );

  return json(created, { status: 201 });
};

import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, noContent, notFound, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { ensureTags, loadBookmark, setBookmarkTags } from '../../_lib/db';
import { canonicalUrl, urlKey } from '../../_lib/urlkey';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const bookmark = await loadBookmark(ctx.env, userId, String(ctx.params.id));
  if (!bookmark) throw notFound('书签不存在');
  return json(bookmark);
};

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const owned = await ctx.env.DB.prepare(
    `SELECT id FROM bookmarks WHERE id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(id, userId)
    .first<{ id: string }>();
  if (!owned) throw notFound('书签不存在');

  const body = await readJson<Record<string, unknown>>(ctx.request);

  const sets: string[] = [];
  const params: unknown[] = [];

  const text = (key: string, column: string, max: number) => {
    if (!(key in body)) return;
    const raw = body[key];
    sets.push(`${column} = ?`);
    params.push(raw === null || raw === '' ? null : String(raw).slice(0, max));
  };

  if ('url' in body) {
    const url = canonicalUrl(String(body.url ?? ''));
    if (!url) throw badRequest('网址格式不正确', { url: '网址格式不正确' });
    sets.push('url = ?', 'url_key = ?');
    params.push(url, urlKey(url));
  }

  if ('title' in body) {
    const title = String(body.title ?? '').trim();
    if (title) {
      sets.push('title = ?');
      params.push(title.slice(0, 300));
    }
  }

  text('description', 'description', 2000);
  text('note', 'note', 20000);
  text('faviconUrl', 'favicon_url', 500);
  text('coverUrl', 'cover_url', 500);

  if ('isFavorite' in body) {
    sets.push('is_favorite = ?');
    params.push(body.isFavorite ? 1 : 0);
  }
  if ('isArchived' in body) {
    sets.push('is_archived = ?');
    params.push(body.isArchived ? 1 : 0);
  }

  if (sets.length > 0) {
    sets.push('updated_at = ?');
    params.push(nowIso(), id, userId);
    await ctx.env.DB.prepare(
      `UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
    )
      .bind(...params)
      .run();
  }

  // An explicit array replaces the whole set; omitting the field leaves tags
  // untouched. Anything else makes partial updates unpredictable.
  if (Array.isArray(body.tagNames)) {
    const { ids } = await ensureTags(
      ctx.env,
      userId,
      (body.tagNames as unknown[]).map(String).slice(0, 30),
    );
    await setBookmarkTags(ctx.env, id, ids);
  }

  const updated = await loadBookmark(ctx.env, userId, id);
  if (!updated) throw notFound('书签不存在');
  return json(updated);
};

/** Soft delete. Permanent removal goes through /bookmarks/purge. */
export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const result = await ctx.env.DB.prepare(
    `UPDATE bookmarks SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
    .bind(nowIso(), nowIso(), String(ctx.params.id), userId)
    .run();

  if (!result.meta.changes) throw notFound('书签不存在');
  return noContent();
};

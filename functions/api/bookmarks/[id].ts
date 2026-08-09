import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, noContent, notFound, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { clearBookmarkPrivate, ensureTags, loadBookmark, setBookmarkPrivate, setBookmarkTags } from '../../_lib/db';
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

  // Privacy toggle — a zero-knowledge conversion that the generic field update
  // below must not also touch. Set encrypts client-side and blanks the row;
  // clear restores the decrypted plaintext the client re-supplies.
  if ('isPrivate' in body) {
    if (body.isPrivate === true) {
      const encryptedBlob = body.encryptedBlob;
      if (typeof encryptedBlob !== 'string' || !encryptedBlob) {
        throw badRequest('缺少加密数据');
      }
      const ok = await setBookmarkPrivate(ctx.env, userId, id, encryptedBlob);
      if (!ok) throw notFound('书签不存在或已为私密');
      return json({ id, isPrivate: true });
    }
    // Cancel privacy: restore the decrypted plaintext the client unlocked.
    const url = typeof body.url === 'string' ? body.url : '';
    if (!url) throw badRequest('网址格式不正确', { url: '网址格式不正确' });
    const tagNames = Array.isArray(body.tagNames)
      ? (body.tagNames as unknown[]).map(String).slice(0, 30)
      : [];
    const restored = await clearBookmarkPrivate(ctx.env, userId, id, {
      url,
      title: typeof body.title === 'string' ? body.title : '',
      description: typeof body.description === 'string' ? body.description : null,
      note: typeof body.note === 'string' ? body.note : null,
      faviconUrl: typeof body.faviconUrl === 'string' ? body.faviconUrl : null,
      coverUrl: typeof body.coverUrl === 'string' ? body.coverUrl : null,
      tagNames,
    });
    if (!restored) throw notFound('书签不存在或并非私密');
    return json(restored);
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  const text = (key: string, column: string, max: number) => {
    if (!(key in body)) return;
    const raw = body[key];
    sets.push(`${column} = ?`);
    params.push(raw === null || raw === '' ? null : String(raw).slice(0, max));
  };

  let urlChanged = false;
  if ('url' in body) {
    const url = canonicalUrl(String(body.url ?? ''));
    if (!url) throw badRequest('网址格式不正确', { url: '网址格式不正确' });

    // The partial UNIQUE index on (user_id, url_key) WHERE deleted_at IS NULL
    // (migration 0004) rejects an edit that points this bookmark at a URL
    // another live bookmark already holds. Left unchecked, D1 threw and the
    // user saw "服务器内部错误" for what is really a duplicate — the same
    // situation POST /api/bookmarks reports as a 409 with the existing id.
    const key = urlKey(url);
    const clash = await ctx.env.DB.prepare(
      `SELECT id FROM bookmarks
        WHERE user_id = ? AND url_key = ? AND deleted_at IS NULL AND id <> ? LIMIT 1`,
    )
      .bind(userId, key, id)
      .first<{ id: string }>();
    if (clash) throw conflict('该网址已在书签库中', { id: clash.id });

    urlChanged = true;
    sets.push('url = ?', 'url_key = ?');
    params.push(url, key);
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
    try {
      await ctx.env.DB.prepare(
        `UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
      )
        .bind(...params)
        .run();
    } catch (e) {
      // The pre-check above narrows the window but cannot close it: a
      // concurrent save of the same URL still loses at the index. Report it
      // as the duplicate it is rather than as an opaque 500.
      if (urlChanged && isUrlConflict(e)) throw conflict('该网址已在书签库中');
      throw e;
    }
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

/**
 * Whether a D1 failure is the live-duplicate URL index rejecting the write.
 * D1 reports it as `UNIQUE constraint failed: bookmarks.user_id,
 * bookmarks.url_key`; anything else must keep bubbling up untouched.
 */
function isUrlConflict(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg) && /url_key/i.test(msg);
}

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

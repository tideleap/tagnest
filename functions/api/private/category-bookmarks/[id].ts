import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, conflict, json, noContent, notFound, readJson } from '../../../_lib/http';
import { loadPrivateTagBookmark, updateBookmarkFields } from '../../../_lib/db';
import { canonicalUrl, urlKey } from '../../../_lib/urlkey';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const bookmark = await loadPrivateTagBookmark(ctx.env, userId, String(ctx.params.id));
  if (!bookmark) throw notFound('书签不存在');
  return json(bookmark);
};

interface PatchInput {
  url?: string;
  title?: string;
  description?: string | null;
  note?: string | null;
  faviconUrl?: string | null;
  coverUrl?: string | null;
  isFavorite?: boolean;
  isArchived?: boolean;
  tagNames?: string[];
}

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  // Scope check: this endpoint only edits bookmarks hidden by a private tag.
  const existing = await loadPrivateTagBookmark(ctx.env, userId, id);
  if (!existing) throw notFound('书签不存在');

  const body = await readJson<Record<string, unknown>>(ctx.request);

  // Privacy conversion is handled by the dedicated /bookmarks/:id endpoint.
  if ('isPrivate' in body) {
    throw badRequest('请在普通书签编辑中移入或移出保险库');
  }

  const patch: PatchInput = {};

  if ('url' in body) {
    const url = canonicalUrl(String(body.url ?? ''));
    if (!url) throw badRequest('网址格式不正确', { url: '网址格式不正确' });

    const key = urlKey(url);
    const clash = await ctx.env.DB.prepare(
      `SELECT id FROM bookmarks
        WHERE user_id = ? AND url_key = ? AND deleted_at IS NULL AND id <> ? LIMIT 1`,
    )
      .bind(userId, key, id)
      .first<{ id: string }>();
    if (clash) throw conflict('该网址已在书签库中', { id: clash.id });

    patch.url = url;
  }

  if ('title' in body) {
    const title = String(body.title ?? '').trim();
    if (title) patch.title = title.slice(0, 300);
  }

  const text = (key: string, target: keyof PatchInput) => {
    if (!(key in body)) return;
    const raw = body[key];
    (patch as Record<string, unknown>)[target] = raw === null || raw === '' ? null : String(raw);
  };
  text('description', 'description');
  text('note', 'note');
  text('faviconUrl', 'faviconUrl');
  text('coverUrl', 'coverUrl');

  if ('isFavorite' in body) patch.isFavorite = Boolean(body.isFavorite);
  if ('isArchived' in body) patch.isArchived = Boolean(body.isArchived);

  if (Array.isArray(body.tagNames)) {
    patch.tagNames = (body.tagNames as unknown[]).map(String).slice(0, 30);
  }

  const updated = await updateBookmarkFields(ctx.env, userId, id, patch);
  if (!updated) throw notFound('书签不存在');

  const result = await loadPrivateTagBookmark(ctx.env, userId, id);
  if (!result) {
    // The bookmark still exists but no longer carries a private tag, so it has
    // left the vault view. Return a marker so the UI can close gracefully
    // instead of showing a 404.
    return json({ removedFromVault: true, bookmark: updated });
  }
  return json(result);
};

export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const existing = await loadPrivateTagBookmark(ctx.env, userId, id);
  if (!existing) throw notFound('书签不存在');

  const result = await ctx.env.DB.prepare(
    `UPDATE bookmarks SET deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
    .bind(id, userId)
    .run();

  if (!result.meta.changes) throw notFound('书签不存在');
  return noContent();
};

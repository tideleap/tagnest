import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, noContent, notFound, readJson } from '../../../_lib/http';
import {
  deletePrivateBookmark,
  loadPrivateBookmarkRow,
  updatePrivateBookmark,
  type PrivateBookmarkRow,
} from '../../../_lib/db';

/** GET /api/private/bookmarks/:id — one private bookmark's ciphertext. */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const row = await loadPrivateBookmarkRow(ctx.env, userId, String(ctx.params.id));
  if (!row) throw notFound('私密书签不存在');
  const r = row as PrivateBookmarkRow;
  return json({
    id: r.id,
    encryptedBlob: r.encryptedBlob,
    isFavorite: r.isFavorite,
    isArchived: r.isArchived,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
};

/** PATCH /api/private/bookmarks/:id — re-encrypt after an edit. */
export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ encryptedBlob?: string }>(ctx.request);
  if (typeof body.encryptedBlob !== 'string' || !body.encryptedBlob) {
    throw badRequest('缺少加密数据');
  }
  const ok = await updatePrivateBookmark(ctx.env, userId, String(ctx.params.id), body.encryptedBlob);
  if (!ok) throw notFound('私密书签不存在');
  return json({ id: String(ctx.params.id), encryptedBlob: body.encryptedBlob });
};

/** DELETE /api/private/bookmarks/:id — permanently remove a private bookmark. */
export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const removed = await deletePrivateBookmark(ctx.env, userId, String(ctx.params.id));
  if (!removed) throw notFound('私密书签不存在');
  return noContent();
};

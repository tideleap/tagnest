import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, readJson } from '../../../_lib/http';
import { createPrivateBookmark, listPrivateBookmarkRows, type PrivateBookmarkRow } from '../../../_lib/db';

/**
 * GET /api/private/bookmarks
 *
 * Returns the user's private bookmarks — but only as ciphertext. The server
 * has no key, so this endpoint is safe to call over an authenticated channel:
 * without the passphrase the payloads are unreadable. The client decrypts
 * locally after the user unlocks the vault.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const rows = await listPrivateBookmarkRows(ctx.env, userId);
  const items: PrivateBookmarkRow[] = rows.map((r) => ({
    id: r.id,
    encryptedBlob: r.encryptedBlob,
    isFavorite: r.isFavorite,
    isArchived: r.isArchived,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  return json({ items });
};

/**
 * POST /api/private/bookmarks
 *
 * Creates a brand-new private bookmark directly inside the vault. The client
 * encrypts the fields before sending, so the server never sees plaintext.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{
    encryptedBlob?: string;
    isFavorite?: boolean;
    isArchived?: boolean;
  }>(ctx.request);
  if (typeof body.encryptedBlob !== 'string' || !body.encryptedBlob) {
    throw badRequest('缺少加密数据');
  }
  const id = await createPrivateBookmark(
    ctx.env,
    userId,
    body.encryptedBlob,
    Boolean(body.isFavorite),
    Boolean(body.isArchived),
  );
  return json({ id }, { status: 201 });
};

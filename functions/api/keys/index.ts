import type { ApiKeyCreated } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { createApiKey, mapApiKey, parseScopes } from '../../_lib/apikeys';
import { badRequest, json, readJson } from '../../_lib/http';
import { isoFromNow } from '../../_lib/ids';

/**
 * Personal access key collection.
 *
 * Reachable only with a browser session — the middleware refuses to serve
 * /api/keys to a request that authenticated with a key, so a leaked key
 * cannot bootstrap more keys.
 */

/** A cap, not a quota: unlimited keys make the revocation list unusable. */
const MAX_KEYS = 20;

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const rows = await ctx.env.DB.prepare(
    `SELECT id, name, prefix, scopes, last_used_at, created_at, expires_at
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();

  return json({ items: rows.results.map(mapApiKey) });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  if (!name) throw badRequest('请填写密钥名称', { name: '请填写密钥名称' });

  const scopes = parseScopes(body.scopes);

  let expiresAt: string | null = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const days = Number(body.expiresInDays);
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      throw badRequest('有效期需在 0-3650 天之间');
    }
    if (days > 0) expiresAt = isoFromNow(days * 24 * 60 * 60 * 1000);
  }

  const count = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ c: number }>();

  if (Number(count?.c ?? 0) >= MAX_KEYS) {
    throw badRequest(`最多只能创建 ${MAX_KEYS} 个密钥，请先删除不用的`);
  }

  const created = await createApiKey(ctx.env, userId, name, scopes, expiresAt);

  // The only time the plaintext exists outside the client's memory.
  const payload: ApiKeyCreated = { key: created.record, token: created.token };
  return json(payload, { status: 201 });
};

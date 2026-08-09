import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';

/**
 * GET /api/private/vault
 *
 * Reports whether the user has set up a vault, and returns the PBKDF2 salt
 * (a public value — it is useless without the passphrase). The client needs
 * the salt to derive the decryption key from the passphrase it is about to
 * receive from the user.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const row = await ctx.env.DB.prepare(
    `SELECT salt, verifier FROM private_vault WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ salt: string; verifier: string }>();
  return json({ configured: Boolean(row), salt: row?.salt ?? null, verifier: row?.verifier ?? null });
};

/**
 * POST /api/private/vault
 *
 * Creates the vault. The body carries the salt and a verifier — an
 * AES-GCM encryption of a known constant performed client-side from the
 * passphrase. The server stores both but can never derive the key, so it
 * can only confirm (never recover) a passphrase. Provisioning is one-shot:
 * changing the passphrase would orphan every existing ciphertext, so that is
 * out of scope for v1.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ salt?: string; verifier?: string }>(ctx.request);
  if (typeof body.salt !== 'string' || !body.salt || typeof body.verifier !== 'string' || !body.verifier) {
    throw badRequest('缺少 salt 或 verifier');
  }
  const existing = await ctx.env.DB.prepare(
    `SELECT user_id FROM private_vault WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ user_id: string }>();
  if (existing) throw conflict('私密保险库已设置');

  const ts = nowIso();
  await ctx.env.DB.prepare(
    `INSERT INTO private_vault (user_id, salt, verifier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(userId, body.salt, body.verifier, ts, ts)
    .run();
  return json({ configured: true });
};

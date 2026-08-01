import type { ApiKey, ApiKeyScope } from '../../shared/types';
import { sha256Hex } from './crypto';
import type { Env } from './env';
import { badRequest } from './http';
import { base64UrlEncode, newId, nowIso } from './ids';

/**
 * Personal access keys.
 *
 * The browser session uses a 15-minute JWT plus a rotating refresh cookie,
 * which is the right shape for a tab that can redirect to a login form. It is
 * the wrong shape for a browser extension's background worker or a cron
 * script: they need one long-lived credential they can present directly.
 *
 * Only the SHA-256 digest is persisted. The plaintext is returned exactly
 * once, at creation, and cannot be recovered afterwards.
 */

/** Distinguishes a key from a JWT at a glance, in logs and in the middleware. */
export const KEY_PREFIX = 'tnk_';

/** Shown in the UI so a key is identifiable without being reconstructable. */
const VISIBLE_CHARS = 12;

export const SCOPES: ApiKeyScope[] = ['read', 'write'];

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX);
}

export function generateKey(): string {
  // 32 bytes → 43 base64url chars, ~256 bits. Guessing is not a threat model.
  return `${KEY_PREFIX}${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function parseScopes(raw: unknown): ApiKeyScope[] {
  if (raw === undefined || raw === null) return ['read', 'write'];

  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const picked = [...new Set(list.map((s) => String(s).trim().toLowerCase()))].filter(
    (s): s is ApiKeyScope => (SCOPES as string[]).includes(s),
  );

  if (picked.length === 0) throw badRequest('权限范围无效，可选 read / write');
  // `write` without `read` is a footgun: every write endpoint reads first.
  if (picked.includes('write') && !picked.includes('read')) picked.unshift('read');
  return picked;
}

export function mapApiKey(row: Record<string, unknown>): ApiKey {
  return {
    id: row.id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    scopes: String(row.scopes ?? '').split(',').filter(Boolean) as ApiKeyScope[],
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string | null) ?? null,
  };
}

export interface CreatedKey {
  record: ApiKey;
  /** Plaintext. Returned once; never stored. */
  token: string;
}

export async function createApiKey(
  env: Env,
  userId: string,
  name: string,
  scopes: ApiKeyScope[],
  expiresAt: string | null,
): Promise<CreatedKey> {
  const token = generateKey();
  const id = newId();
  const ts = nowIso();
  const prefix = token.slice(0, VISIBLE_CHARS);

  await env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, token_hash, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, name, prefix, await sha256Hex(token), scopes.join(','), ts, expiresAt)
    .run();

  return {
    token,
    record: {
      id,
      name,
      prefix,
      scopes,
      lastUsedAt: null,
      createdAt: ts,
      expiresAt,
    },
  };
}

export interface ResolvedKey {
  userId: string;
  keyId: string;
  scopes: ApiKeyScope[];
}

/**
 * Looks a presented key up by digest.
 *
 * `last_used_at` is refreshed on a hit so a user can spot and revoke a key
 * that is still being used by something they forgot about. The write is fired
 * without awaiting the round trip — a stale timestamp is not worth adding
 * latency to every extension request.
 */
export async function resolveApiKey(
  env: Env,
  token: string,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<ResolvedKey | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT id, user_id, scopes, expires_at FROM api_keys WHERE token_hash = ? LIMIT 1`,
  )
    .bind(hash)
    .first<Record<string, unknown>>();

  if (!row) return null;

  const expiresAt = row.expires_at as string | null;
  if (expiresAt && expiresAt <= nowIso()) return null;

  const touch = env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
    .bind(nowIso(), row.id as string)
    .run();

  if (waitUntil) waitUntil(touch.catch(() => undefined));
  else await touch.catch(() => undefined);

  return {
    userId: row.user_id as string,
    keyId: row.id as string,
    scopes: String(row.scopes ?? '').split(',').filter(Boolean) as ApiKeyScope[],
  };
}

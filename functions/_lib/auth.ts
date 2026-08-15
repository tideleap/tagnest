import type { User } from '../../shared/types';
import type { Ctx, Env } from './env';
import { isDeployedPages } from './env';
import { base64UrlDecode, base64UrlEncode, isoFromNow, newId, nowIso, randomToken } from './ids';
import { ApiException, unauthorized } from './http';
import { sha256Hex } from './crypto';

/* ------------------------------------------------------------------ *
 * Password hashing
 * ------------------------------------------------------------------ */

/**
 * PBKDF2 is not the strongest choice on paper — Argon2id is — but it is the
 * only password KDF exposed by the Workers WebCrypto runtime, and a native
 * implementation beats a WASM Argon2 that would blow the CPU budget.
 *
 * 100k iterations is the OWASP floor for PBKDF2-HMAC-SHA256 and stays inside
 * the request CPU limit. Raise it via PBKDF2_ITERATIONS; the cost is recorded
 * in each stored hash, so old passwords keep verifying.
 */
const DEFAULT_ITERATIONS = 100_000;
const MAX_ITERATIONS = 1_000_000;

const encoder = new TextEncoder();

function iterationsFor(env: Env): number {
  const parsed = Number.parseInt(env.PBKDF2_ITERATIONS ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 10_000) return DEFAULT_ITERATIONS;
  return Math.min(parsed, MAX_ITERATIONS);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, env: Env): Promise<string> {
  const iterations = iterationsFor(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(digest)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterRaw, saltRaw, digestRaw] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterRaw || !saltRaw || !digestRaw) return false;

  const iterations = Number.parseInt(iterRaw, 10);
  if (!Number.isFinite(iterations) || iterations <= 0 || iterations > MAX_ITERATIONS) return false;

  const candidate = await pbkdf2(password, base64UrlDecode(saltRaw), iterations);
  return timingSafeEqual(candidate, base64UrlDecode(digestRaw));
}

/** Constant-time comparison; a short-circuiting `===` leaks the digest byte by byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Access tokens (JWT, HS256)
 * ------------------------------------------------------------------ */

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEV_SECRET = 'tagnest-insecure-development-secret-change-me';

function secretFor(env: Env): string {
  const secret = env.JWT_SECRET?.trim();
  if (secret && secret.length >= 16) return secret;

  // On live Pages deployments a missing/short secret is a configuration
  // accident that would silently downgrade every session token to a publicly
  // known key — refuse instead of degrading. Local dev (`wrangler pages dev`,
  // unit tests) keeps the fixed fallback so the project runs out of the box.
  if (isDeployedPages(env)) {
    throw new Error(
      'JWT_SECRET is unset or shorter than 16 characters. ' +
        'Set it with `wrangler pages secret put JWT_SECRET`, then redeploy.',
    );
  }

  console.warn(
    '[tagnest] JWT_SECRET is unset or too short; using the development secret. ' +
      'Run `wrangler pages secret put JWT_SECRET` before deploying.',
  );
  return DEV_SECRET;
}

async function hmacKey(env: Env) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secretFor(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
}

export async function signAccessToken(userId: string, env: Env): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    sub: userId,
    iat: now,
    exp: now + Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const data = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(data));
  return `${data}.${base64UrlEncode(sig)}`;
}

export async function verifyAccessToken(token: string, env: Env): Promise<string | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(env),
      base64UrlDecode(signature) as BufferSource,
      encoder.encode(`${header}.${payload}`),
    );
    if (!valid) return null;

    let claims: JwtClaims;
    try {
      claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    } catch {
      return null;
    }

    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 <= Date.now()) return null;

    return claims.sub;
  } catch {
    // A malformed-but-structurally-valid token (e.g. three dot-separated
    // junk segments) must fail closed, never throw into the middleware.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Refresh sessions
 * ------------------------------------------------------------------ */

export const REFRESH_COOKIE = 'tn_rt';

export async function createSession(
  env: Env,
  userId: string,
  userAgent: string | null,
): Promise<string> {
  const token = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId(),
      userId,
      await sha256Hex(token),
      userAgent?.slice(0, 200) ?? null,
      nowIso(),
      isoFromNow(REFRESH_TOKEN_TTL_MS),
    )
    .run();
  return token;
}

export async function resolveSession(env: Env, token: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1`,
  )
    .bind(await sha256Hex(token), nowIso())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export async function revokeSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`)
    .bind(await sha256Hex(token))
    .run();
}

/**
 * Rotates the refresh token on every use.
 *
 * A stolen token is therefore usable at most once, and the legitimate client's
 * next refresh fails — which surfaces the compromise instead of hiding it.
 */
export async function rotateSession(
  env: Env,
  oldToken: string,
  userId: string,
  userAgent: string | null,
): Promise<string> {
  const next = randomToken(32);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256Hex(oldToken)),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(),
      userId,
      await sha256Hex(next),
      userAgent?.slice(0, 200) ?? null,
      nowIso(),
      isoFromNow(REFRESH_TOKEN_TTL_MS),
    ),
  ]);
  return next;
}

/* ------------------------------------------------------------------ *
 * Cookies
 * ------------------------------------------------------------------ */

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        // Malformed percent-encoding (e.g. `tn_rt=%zz`) would throw URIError
        // and propagate as a 500; a bad cookie must be treated as absent.
        return null;
      }
    }
  }
  return null;
}

export function refreshCookie(request: Request, token: string | null): string {
  const secure = new URL(request.url).protocol === 'https:';
  const attrs = [
    `${REFRESH_COOKIE}=${token ?? ''}`,
    // Scoped to the auth routes only — no other endpoint should ever see it,
    // which keeps the app's CSRF surface limited to /api/auth/*.
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    token ? `Max-Age=${Math.floor(REFRESH_TOKEN_TTL_MS / 1000)}` : 'Max-Age=0',
  ];
  return attrs.filter(Boolean).join('; ');
}

/* ------------------------------------------------------------------ *
 * Request authentication
 * ------------------------------------------------------------------ */

export function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function loadUser(env: Env, userId: string): Promise<User | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, display_name, avatar_url, created_at FROM users WHERE id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<Record<string, unknown>>();
  return row ? mapUser(row) : null;
}

/**
 * Resolves the bearer token attached by the middleware.
 *
 * Throws rather than returning null: handlers that call this are, by
 * definition, ones that cannot proceed anonymously.
 */
export function requireUserId(ctx: Ctx): string {
  const id = ctx.data.userId;
  if (!id) throw unauthorized();
  return id;
}

export async function authenticate(request: Request, env: Env): Promise<string | null> {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  return verifyAccessToken(token, env);
}

/* ------------------------------------------------------------------ *
 * Credential validation
 * ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateCredentials(email: unknown, password: unknown): {
  email: string;
  password: string;
} {
  const details: Record<string, string> = {};

  const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!mail) details.email = '请输入邮箱';
  else if (mail.length > 254 || !EMAIL_RE.test(mail)) details.email = '邮箱格式不正确';

  const pass = typeof password === 'string' ? password : '';
  if (!pass) details.password = '请输入密码';
  else if (pass.length < 8) details.password = '密码至少 8 位';
  else if (pass.length > 256) details.password = '密码过长';

  if (Object.keys(details).length > 0) {
    throw new ApiException(400, 'validation_failed', '请检查填写的内容', details);
  }
  return { email: mail, password: pass };
}

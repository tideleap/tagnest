import type { Env, RequestData } from '../_lib/env';
import { authenticate } from '../_lib/auth';
import { looksLikeApiKey, resolveApiKey } from '../_lib/apikeys';
import { errorResponse, forbidden, unauthorized } from '../_lib/http';

/**
 * Routes reachable without an access token.
 *
 * Authentication is enforced here rather than in each handler: an allowlist
 * fails closed, so a new endpoint added tomorrow is protected by default.
 */
const PUBLIC_PATHS = new Set([
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/health',
]);

/** Anonymous read surface for published share pages. */
const PUBLIC_PREFIXES = ['/api/public/'];

/**
 * Routes a personal access key may never reach.
 *
 * A leaked extension key must not be able to mint more keys, read the session
 * list, or change the password — otherwise revocation becomes a race the
 * attacker can win.
 */
const KEY_DENIED_PREFIXES = ['/api/keys', '/api/auth/'];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Hardening headers applied to every response the Functions layer touches.
 *
 * `script-src` keeps `'unsafe-inline'` on purpose: index.html ships a tiny
 * inline theme script that must run before first paint to avoid a flash. The
 * rest of the policy is strict — no third-party origins, no form targets, no
 * framing. HSTS is added defensively; Cloudflare already sends it on *.pages.dev.
 */
function securityHeaders(): Record<string, string> {
  return {
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

/**
 * Reads the presented credential.
 *
 * `X-API-Key` exists because some extension and CLI plumbing mangles or
 * strips `Authorization`; both headers carry the same value space, and the
 * `tnk_` prefix is what actually decides how the token is interpreted.
 */
function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  return request.headers.get('X-API-Key')?.trim() || null;
}

export const onRequest: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const { request, env, next, data } = ctx;
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          Allow: 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (!env.DB) {
      throw new Error('D1 binding "DB" is missing; check wrangler.toml');
    }

    const presented = bearerToken(request);

    if (presented && looksLikeApiKey(presented)) {
      if (KEY_DENIED_PREFIXES.some((p) => path.startsWith(p))) {
        throw forbidden('该接口不支持 API 密钥调用，请使用登录会话');
      }

      const resolved = await resolveApiKey(env, presented, (p) => ctx.waitUntil(p));
      if (!resolved) throw unauthorized('API 密钥无效或已过期');

      if (!READ_METHODS.has(request.method) && !resolved.scopes.includes('write')) {
        throw forbidden('该 API 密钥没有写入权限');
      }

      data.userId = resolved.userId;
      data.apiKeyId = resolved.keyId;
      data.apiKeyScopes = resolved.scopes;
    } else {
      const userId = await authenticate(request, env);
      if (userId) data.userId = userId;
    }

    const isPublic = PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
    if (!isPublic && !data.userId) throw unauthorized();

    const response = await next();

    // Same-origin API: no framing, no MIME sniffing, no referrer leakage.
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'same-origin');
    for (const [k, v] of Object.entries(securityHeaders())) {
      headers.set(k, v);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (e) {
    return errorResponse(e);
  }
};

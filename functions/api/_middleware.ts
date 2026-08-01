import type { Env, RequestData } from '../_lib/env';
import { authenticate } from '../_lib/auth';
import { errorResponse, unauthorized } from '../_lib/http';

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

    const userId = await authenticate(request, env);
    if (userId) data.userId = userId;

    if (!PUBLIC_PATHS.has(path) && !userId) throw unauthorized();

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

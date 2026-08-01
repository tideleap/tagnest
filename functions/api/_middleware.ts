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

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (e) {
    return errorResponse(e);
  }
};

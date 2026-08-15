import type { Env, RequestData } from '../../_lib/env';
import { ApiException, json, notFound } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { verifyPassword } from '../../_lib/auth';
import { mapShare, readCache, renderShare, writeCache } from '../../_lib/shares';

/**
 * Anonymous read endpoint behind /s/:slug.
 *
 * The middleware allowlists /api/public/, so no credential is required. Three
 * layers keep this cheap under a link that gets passed around:
 *
 *   1. KV, when the binding exists — a hit skips D1 entirely.
 *   2. `Cache-Control: public, max-age=60` — the Cloudflare edge and the
 *      browser both hold it, which absorbs a refresh storm.
 *   3. `waitUntil` for the view counter, so counting never delays the
 *      response.
 *
 * The `no-store` default from `json()` is overridden here deliberately: this
 * is the one route in the API whose body is not account-specific.
 *
 * Password-protected shares are the exception to every layer above: the KV
 * cache and the public Cache-Control are both skipped (a cached body would be
 * served to visitors who never proved they know the password), and the gate
 * itself runs before any rendering work.
 */

const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

/** Header the viewer presents the share password through. */
const PASSWORD_HEADER = 'x-share-password';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const slug = String(ctx.params.slug ?? '').toLowerCase();
  if (!slug) throw notFound('分享页不存在');

  // Fast path: open shares served from the edge cache. A password-protected
  // share is never cached, so a hit here is by definition unprotected.
  const cached = await readCache(ctx.env, slug);
  if (cached) {
    ctx.waitUntil(bumpViews(ctx.env, slug));
    return json(cached, {
      headers: { 'Cache-Control': PUBLIC_CACHE, 'X-Cache': 'HIT' },
    });
  }

  const row = await ctx.env.DB.prepare(`SELECT * FROM shares WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<Record<string, unknown>>();

  // Disabled and expired shares answer 404, not 403: confirming that a link
  // once existed is itself information the owner did not agree to publish.
  if (!row) throw notFound('分享页不存在或已关闭');

  const share = mapShare(row);
  if (!share.isActive) throw notFound('分享页不存在或已关闭');
  if (share.expiresAt && share.expiresAt <= nowIso()) throw notFound('分享页已过期');

  // Password gate. The hash never leaves the server; only presence is known
  // to the client. 401 = "a password is required" (with just enough to render
  // the prompt), 403 = "the password you gave is wrong".
  if (share.hasPassword) {
    const presented = ctx.request.headers.get(PASSWORD_HEADER) ?? '';
    if (!presented) {
      throw new ApiException(401, 'share_password_required', '这个分享页需要访问密码', {
        requiresPassword: 'true',
        title: share.title,
        palette: share.palette,
      });
    }
    const ok = await verifyPassword(presented, String(row.password_hash));
    if (!ok) {
      throw new ApiException(403, 'share_password_invalid', '访问密码不正确');
    }
  }

  const payload = await renderShare(ctx.env, share, row.user_id as string);
  // The backing collection of a collection-share was deleted after publishing.
  if (!payload) throw notFound('分享页不存在或已关闭');

  ctx.waitUntil(bumpViews(ctx.env, slug));

  // Only open shares are worth caching at the edge; password-gated bodies go
  // straight to the visitor who earned them, with no shared copy behind.
  if (!share.hasPassword) {
    ctx.waitUntil(writeCache(ctx.env, slug, payload));
    return json(payload, {
      headers: { 'Cache-Control': PUBLIC_CACHE, 'X-Cache': 'MISS' },
    });
  }

  return json(payload);
};

/** Best-effort; a lost increment is not worth failing a page render over. */
async function bumpViews(env: Env, slug: string): Promise<void> {
  try {
    await env.DB.prepare(`UPDATE shares SET view_count = view_count + 1 WHERE slug = ?`)
      .bind(slug)
      .run();
  } catch (e) {
    console.warn('[tagnest] share view counter failed', e);
  }
}

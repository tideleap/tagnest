import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { verifyPassword } from '../../../_lib/auth';
import { ApiException, json, notFound, readJson } from '../../../_lib/http';
import { nowIso, newId } from '../../../_lib/ids';
import { canonicalUrl, urlKey, faviconFor, titleFallback } from '../../../_lib/urlkey';
import { ensureTags, setBookmarkTags } from '../../../_lib/db';
import { mapShare, renderShare, MAX_PUBLIC_ITEMS } from '../../../_lib/shares';

/**
 * H2 / C3 — "收藏即收集".
 *
 * A signed-in viewer of someone else's public share page can copy its bookmarks
 * into their own library in one action. The share is the source of truth (a
 * saved query, not a snapshot), so we resolve the live items exactly as the
 * public page does, then upsert each into the collector's account.
 *
 * De-duplication uses the same partial-unique `(user_id, url_key)` index the
 * normal save path relies on: an `INSERT OR IGNORE` that hits an existing live
 * URL yields no row and is counted as `skipped`, never duplicated. Tags from
 * the share item are carried over, and the collector may append their own
 * `tagNames` on top.
 *
 * Password-protected shares keep their gate: collecting requires the same
 * `X-Share-Password` header, so a protected list is never scrapable without the
 * secret.
 */
const PASSWORD_HEADER = 'x-share-password';
const MAX_COLLECT = MAX_PUBLIC_ITEMS;

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const viewerId = requireUserId(ctx);
  const slug = String(ctx.params.slug ?? '').toLowerCase();
  if (!slug) throw notFound('分享页不存在');

  const row = await ctx.env.DB.prepare(`SELECT * FROM shares WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('分享页不存在或已关闭');

  const share = mapShare(row);
  if (!share.isActive) throw notFound('分享页不存在或已关闭');
  if (share.expiresAt && share.expiresAt <= nowIso()) throw notFound('分享页已过期');

  if (share.hasPassword) {
    const presented = ctx.request.headers.get(PASSWORD_HEADER) ?? '';
    if (!presented) {
      throw new ApiException(401, 'share_password_required', '这个分享页需要访问密码');
    }
    const ok = await verifyPassword(presented, String(row.password_hash));
    if (!ok) throw new ApiException(403, 'share_password_invalid', '访问密码不正确');
  }

  const payload = await renderShare(ctx.env, share, row.user_id as string);
  if (!payload) throw notFound('分享页不存在或已关闭');

  let body: { urls?: unknown[]; tagNames?: unknown[] };
  try {
    body = await readJson<{ urls?: unknown[]; tagNames?: unknown[] }>(ctx.request);
  } catch {
    // A malformed or empty body is treated as "collect everything, no extra
    // tags" rather than a hard error.
    body = {};
  }

  const wanted = new Set(
    Array.isArray(body.urls) ? body.urls.map(String).filter(Boolean) : [],
  );
  let items = payload.items;
  if (wanted.size > 0) items = items.filter((i) => wanted.has(i.url));

  const extraTagNames = Array.isArray(body.tagNames)
    ? [...new Set(body.tagNames.map(String).filter(Boolean))].slice(0, 30)
    : [];
  // Tag names collected from the share source are bounded alongside the user's
  // own additions so a huge shared list can't blow the 30-tag ceiling.
  const perItemCap = Math.max(0, 30 - extraTagNames.length);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of items.slice(0, MAX_COLLECT)) {
    const url = canonicalUrl(item.url);
    if (!url) {
      failed += 1;
      continue;
    }
    const key = urlKey(url);
    const ts = nowIso();
    const title = (item.title || titleFallback(url)).slice(0, 300);
    const id = newId();

    try {
      const inserted = await ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO bookmarks
           (id, user_id, url, url_key, title, description, favicon_url, note,
            ai_summary, is_favorite, is_archived, visit_count, last_visited_at,
            created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, NULL, ?, ?, NULL)
         RETURNING id`,
      )
        .bind(
          id,
          viewerId,
          url,
          key,
          title,
          item.description ? String(item.description).slice(0, 2000) : null,
          faviconFor(url),
          item.note ? String(item.note).slice(0, 20000) : null,
          ts,
          ts,
        )
        .first<{ id: string }>();

      if (!inserted) {
        skipped += 1;
        continue;
      }

      const tagNames = [
        ...item.tags.map((t) => t.name).filter(Boolean).slice(0, perItemCap),
        ...extraTagNames,
      ];
      if (tagNames.length > 0) {
        const { ids } = await ensureTags(ctx.env, viewerId, tagNames);
        await setBookmarkTags(ctx.env, inserted.id, ids);
      }
      added += 1;
    } catch {
      // A single bad row must not abort the batch; count it and move on so a
      // partial collect still lands the rest.
      failed += 1;
    }
  }

  return json({ added, skipped, failed, total: items.length }, { status: 200 });
};

import type {
  PublicBookmark,
  PublicShare,
  Share,
  SharePalette,
  ShareTheme,
} from '../../shared/types';
import type { Env } from './env';
import { badRequest } from './http';
import { newId } from './ids';

/**
 * Public share pages.
 *
 * A share stores a *query*, not a snapshot: slug, title, and the tag filter
 * to run. Published lists therefore track edits automatically, revocation is
 * immediate, and there is no second copy of the data to keep consistent.
 *
 * The public payload is deliberately narrow — no ids that map to the private
 * API, no visit counts, no archive state. Notes are opt-in per share because
 * they routinely contain things the owner never meant to publish.
 */

export const THEMES: ShareTheme[] = ['default', 'compact', 'cards'];

/** The color palettes a share page may render with. */
export const PALETTES: SharePalette[] = ['light', 'dark', 'aurora', 'blossom', 'starlight'];

/** Hard ceiling on a public page; also bounds the KV value size. */
export const MAX_PUBLIC_ITEMS = 300;

/** Cache lifetime at the edge. Short enough that an edit shows up quickly. */
const CACHE_TTL_SECONDS = 60;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Slugs that would collide with app routes or read as official. */
const RESERVED = new Set([
  'api', 'admin', 'login', 'logout', 'register', 'settings', 'tags',
  'import', 'export', 'new', 'edit', 'share', 'shares', 's', 'public',
  'health', 'assets', 'static',
]);

export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/**
 * Derives a slug from the title, falling back to a random one.
 *
 * A Chinese title normalises to an empty string — every character is stripped
 * by the ASCII filter — so the fallback is the common path here, not an edge
 * case. Random slugs are also unguessable, which is the safer default for a
 * link the owner may consider semi-private.
 */
export function slugFromTitle(title: string): string {
  const derived = normalizeSlug(title);
  if (derived.length >= 3 && !RESERVED.has(derived)) return derived;
  return `list-${newId().slice(-10)}`;
}

export function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw badRequest('链接后缀需为 3-64 位小写字母、数字或连字符', {
      slug: '格式不正确',
    });
  }
  if (RESERVED.has(slug)) {
    throw badRequest('该链接后缀被系统保留，请换一个', { slug: '已被保留' });
  }
}

export function mapShare(row: Record<string, unknown>): Share {
  let tagIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.tag_ids ?? '[]'));
    if (Array.isArray(parsed)) tagIds = parsed.map(String);
  } catch {
    // A malformed column should degrade to "no filter", not break the list.
  }

  const slug = row.slug as string;
  return {
    id: row.id as string,
    slug,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    tagIds,
    matchAllTags: row.match_all_tags === 1,
    includeNotes: row.include_notes === 1,
    theme: (row.theme as ShareTheme) ?? 'default',
    palette: PALETTES.includes(row.palette as SharePalette)
      ? (row.palette as SharePalette)
      : 'light',
    isActive: row.is_active === 1,
    viewCount: Number(row.view_count ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: (row.expires_at as string | null) ?? null,
    url: `/s/${slug}`,
  };
}

/* ------------------------------------------------------------------ *
 * Public rendering
 * ------------------------------------------------------------------ */

/**
 * Runs a share's saved query and shapes the anonymous payload.
 *
 * Trashed and archived bookmarks are always excluded regardless of the
 * filter: neither belongs on a page the owner is showing to other people.
 */
export async function renderShare(
  env: Env,
  share: Share,
  userId: string,
): Promise<PublicShare> {
  const params: unknown[] = [userId];
  const where = ['b.user_id = ?', 'b.deleted_at IS NULL', 'b.is_archived = 0'];

  const ownerRow = await env.DB.prepare(
    `SELECT display_name FROM users WHERE id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ display_name: string }>();

  if (share.tagIds.length > 0) {
    const ph = share.tagIds.map(() => '?').join(',');
    if (share.matchAllTags) {
      where.push(
        `(SELECT COUNT(DISTINCT bt.tag_id) FROM bookmark_tags bt
           WHERE bt.bookmark_id = b.id AND bt.tag_id IN (${ph})) = ?`,
      );
      params.push(...share.tagIds, share.tagIds.length);
    } else {
      where.push(
        `EXISTS (SELECT 1 FROM bookmark_tags bt
                  WHERE bt.bookmark_id = b.id AND bt.tag_id IN (${ph}))`,
      );
      params.push(...share.tagIds);
    }
  }

  const rows = await env.DB.prepare(
    `SELECT b.id, b.url, b.title, b.description, b.favicon_url, b.note,
            b.manual_order, b.created_at
       FROM bookmarks b
      WHERE ${where.join(' AND ')}
      ORDER BY b.manual_order DESC, b.created_at DESC
      LIMIT ?`,
  )
    .bind(...params, MAX_PUBLIC_ITEMS)
    .all<Record<string, unknown>>();

  const ids = rows.results.map((r) => r.id as string);
  const tagsByBookmark = new Map<string, { name: string; colorIndex: number }[]>();

  if (ids.length > 0) {
    const links = await env.DB.prepare(
      `SELECT bt.bookmark_id, t.name, t.color_index
         FROM bookmark_tags bt
         JOIN tags t ON t.id = bt.tag_id
        WHERE bt.bookmark_id IN (${ids.map(() => '?').join(',')})
        ORDER BY t.sort_order, t.name COLLATE NOCASE`,
    )
      .bind(...ids)
      .all<Record<string, unknown>>();

    for (const row of links.results) {
      const key = row.bookmark_id as string;
      const list = tagsByBookmark.get(key) ?? [];
      list.push({ name: row.name as string, colorIndex: Number(row.color_index ?? 0) });
      tagsByBookmark.set(key, list);
    }
  }

  const items: PublicBookmark[] = rows.results.map((r) => ({
    // The bookmark id is already opaque and carries no cross-account meaning;
    // it is kept so the client has a stable React key.
    id: r.id as string,
    url: r.url as string,
    title: (r.title as string) || (r.url as string),
    description: (r.description as string | null) ?? null,
    faviconUrl: (r.favicon_url as string | null) ?? null,
    note: share.includeNotes ? ((r.note as string | null) ?? null) : null,
    tags: tagsByBookmark.get(r.id as string) ?? [],
    createdAt: r.created_at as string,
  }));

  // Headline tags: the filter itself when there is one, otherwise whatever
  // the listed bookmarks actually carry.
  const headline = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) if (!headline.has(tag.name)) headline.set(tag.name, tag.colorIndex);
  }

  return {
    title: share.title,
    description: share.description,
    theme: share.theme,
    palette: share.palette,
    owner: ownerRow?.display_name ?? '',
    tags: [...headline.entries()].slice(0, 12).map(([name, colorIndex]) => ({ name, colorIndex })),
    items,
    total: items.length,
    updatedAt: share.updatedAt,
  };
}

/* ------------------------------------------------------------------ *
 * Edge cache
 *
 * KV is optional. When the binding is absent — local dev, or a deployment
 * that has not provisioned the namespace — every helper is a no-op and the
 * route simply reads D1. The feature must not depend on it.
 * ------------------------------------------------------------------ */

const cacheKey = (slug: string) => `share:${slug}`;

export async function readCache(env: Env, slug: string): Promise<PublicShare | null> {
  if (!env.SHARE_CACHE) return null;
  try {
    return await env.SHARE_CACHE.get<PublicShare>(cacheKey(slug), 'json');
  } catch (e) {
    console.warn('[tagnest] share cache read failed', e);
    return null;
  }
}

export async function writeCache(env: Env, slug: string, payload: PublicShare): Promise<void> {
  if (!env.SHARE_CACHE) return;
  try {
    await env.SHARE_CACHE.put(cacheKey(slug), JSON.stringify(payload), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (e) {
    console.warn('[tagnest] share cache write failed', e);
  }
}

/** Called on every mutation so an edit or revocation is visible immediately. */
export async function purgeCache(env: Env, slug: string): Promise<void> {
  if (!env.SHARE_CACHE) return;
  try {
    await env.SHARE_CACHE.delete(cacheKey(slug));
  } catch (e) {
    console.warn('[tagnest] share cache purge failed', e);
  }
}

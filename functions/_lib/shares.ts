import type {
  DirectoryChildGroup,
  DirectoryGroup,
  PublicBookmark,
  PublicShare,
  Share,
  SharePalette,
  ShareTheme,
} from '../../shared/types';
import type { Env } from './env';
import { badRequest } from './http';
import { newId } from './ids';
import { PRIVATE_BOOKMARK_CLAUSE } from './db';

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

export const THEMES: ShareTheme[] = ['default', 'compact', 'cards', 'directory'];

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
    // Only the *presence* of a password is ever exposed; the hash stays
    // server-side. `undefined` (pre-migration rows) reads as "no password".
    hasPassword: Boolean(row.password_hash),
    collectionId: (row.collection_id as string | null) ?? null,
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
 *
 * Returns `null` when a collection-backed share's collection no longer exists
 * (or belongs to someone else) — the caller turns that into a 404, matching
 * the "disabled share" semantics of not confirming the target ever existed.
 */
export async function renderShare(
  env: Env,
  share: Share,
  userId: string,
): Promise<PublicShare | null> {
  const ownerRow = await env.DB.prepare(
    `SELECT display_name FROM users WHERE id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ display_name: string }>();

  let rows: { results: Record<string, unknown>[] };

  if (share.collectionId) {
    // Collection mode: membership order is the point of a curated list.
    const collection = await env.DB.prepare(
      `SELECT id FROM collections WHERE id = ? AND user_id = ? LIMIT 1`,
    )
      .bind(share.collectionId, userId)
      .first<{ id: string }>();
    if (!collection) return null;

    rows = await env.DB.prepare(
      `SELECT b.id, b.url, b.title, b.description, b.favicon_url, b.note,
              b.manual_order, b.created_at
         FROM collection_bookmarks cb
         JOIN bookmarks b ON b.id = cb.bookmark_id
        WHERE cb.collection_id = ?
          AND b.user_id = ? AND b.deleted_at IS NULL AND b.is_archived = 0
          AND ${PRIVATE_BOOKMARK_CLAUSE}
        ORDER BY cb.position, b.created_at DESC
        LIMIT ?`,
    )
      .bind(share.collectionId, userId, MAX_PUBLIC_ITEMS)
      .all<Record<string, unknown>>();
  } else {
    const params: unknown[] = [userId];
    const where = ['b.user_id = ?', 'b.deleted_at IS NULL', 'b.is_archived = 0', PRIVATE_BOOKMARK_CLAUSE];

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

    rows = await env.DB.prepare(
      `SELECT b.id, b.url, b.title, b.description, b.favicon_url, b.note,
              b.manual_order, b.created_at
         FROM bookmarks b
        WHERE ${where.join(' AND ')}
        ORDER BY b.manual_order DESC, b.created_at DESC
        LIMIT ?`,
    )
      .bind(...params, MAX_PUBLIC_ITEMS)
      .all<Record<string, unknown>>();
  }

  const ids = rows.results.map((r) => r.id as string);
  const tagsByBookmark = new Map<string, { name: string; colorIndex: number }[]>();

  // Directory theme needs the full tag graph (id + parentId) so the client can
  // rebuild first-/second-level groups; the other themes only need labels.
  const directoryTagMap = new Map<
    string,
    { id: string; name: string; colorIndex: number; parentId: string | null }
  >();

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

    if (share.theme === 'directory') {
      // Pull every tag attached to the share's bookmarks so we can resolve
      // parent → child relationships. Restricted to the visible bookmark set
      // (or the whole user, see note below) — orphan tags from other
      // bookmarks never affect grouping here.
      const tagLinks = await env.DB.prepare(
        `SELECT DISTINCT t.id, t.name, t.color_index, t.parent_id
           FROM bookmark_tags bt
           JOIN tags t ON t.id = bt.tag_id
          WHERE bt.bookmark_id IN (${ids.map(() => '?').join(',')})
            AND t.user_id = ?`,
      )
        .bind(...ids, userId)
        .all<Record<string, unknown>>();
      for (const row of tagLinks.results) {
        const id = row.id as string;
        directoryTagMap.set(id, {
          id,
          name: row.name as string,
          colorIndex: Number(row.color_index ?? 0),
          parentId: (row.parent_id as string | null) ?? null,
        });
      }
    }
  }

  // When the directory theme is active the tag list per bookmark is upgraded
  // with id + parentId so DirectoryView can bucket items without a second
  // round-trip. Other themes keep the slim shape for backwards compatibility.
  const items: PublicBookmark[] = rows.results.map((r) => {
    const slim = tagsByBookmark.get(r.id as string) ?? [];
    if (share.theme !== 'directory') {
      return {
        id: r.id as string,
        url: r.url as string,
        title: (r.title as string) || (r.url as string),
        description: (r.description as string | null) ?? null,
        faviconUrl: (r.favicon_url as string | null) ?? null,
        note: share.includeNotes ? ((r.note as string | null) ?? null) : null,
        tags: slim,
        createdAt: r.created_at as string,
      };
    }
    // Merge slim + parentId; fallback to parentId=null when the tag isn't in
    // directoryTagMap (e.g. it was attached after the share was rendered).
    const fullTags = slim.map((s) => {
      const match = [...directoryTagMap.values()].find((t) => t.name === s.name);
      return match ?? { id: '', name: s.name, colorIndex: s.colorIndex, parentId: null };
    });
    return {
      id: r.id as string,
      url: r.url as string,
      title: (r.title as string) || (r.url as string),
      description: (r.description as string | null) ?? null,
      faviconUrl: (r.favicon_url as string | null) ?? null,
      note: share.includeNotes ? ((r.note as string | null) ?? null) : null,
      tags: fullTags,
      createdAt: r.created_at as string,
    };
  });

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
    ...(share.theme === 'directory'
      ? { groups: buildDirectoryGroups(directoryTagMap, items) }
      : {}),
  };
}

/**
 * Bucket bookmarks into a two-level `DirectoryGroup[]` shape.
 *
 * Top-level groups are top-level tags (those with no parentId, or with a
 * parent that isn't carried by any visible bookmark — promoted to top in
 * that case so they don't get lost). Each top-level group owns:
 *   - `directItems`: items carrying the top-level tag and NO child of it
 *   - `children[]`: per child-tag sub-bucket, items carrying that child tag
 *
 * An `__untagged` catch-all group gathers items without any tag at all so
 * they remain reachable from the directory view. Empty groups are dropped.
 *
 * The result is intentionally pre-shaped for the DirectoryView client: the
 * page renders it directly with no further aggregation work.
 */
export function buildDirectoryGroups(
  tagMap: Map<string, { id: string; name: string; colorIndex: number; parentId: string | null }>,
  items: PublicBookmark[],
): DirectoryGroup[] {
  if (items.length === 0) return [];

  // Resolve the visible-graph parent map: for every tag id we collected,
  // figure out who its parent is. Tags whose parent isn't in the graph
  // are treated as top-level so we never strand an island of sub-tags.
  const childByParent = new Map<string, string[]>();
  for (const tag of tagMap.values()) {
    const parent = tag.parentId && tagMap.has(tag.parentId) ? tag.parentId : null;
    const list = childByParent.get(parent ?? '__root__') ?? [];
    list.push(tag.id);
    childByParent.set(parent ?? '__root__', list);
  }

  const topIds = childByParent.get('__root__') ?? [];
  const childrenOf = (id: string) => childByParent.get(id) ?? [];

  // Pre-compute each item's tag-id sets for fast bucket lookup.
  const idsByItem = new Map<string, string[]>();
  for (const item of items) {
    idsByItem.set(
      item.id,
      item.tags.flatMap((t) => (t.id ? [t.id] : [])),
    );
  }

  const groups: DirectoryGroup[] = [];
  const usedItemIds = new Set<string>();

  // Stable top-level ordering: by their primary display order on items, then
  // by name as a tiebreaker. The first appearance wins for cross-tag items.
  const orderedTopIds = [...topIds].sort((a, b) => {
    const tagA = tagMap.get(a)!;
    const tagB = tagMap.get(b)!;
    return tagA.name.localeCompare(tagB.name, 'zh-CN');
  });

  for (const topId of orderedTopIds) {
    const top = tagMap.get(topId)!;
    const childIds = childrenOf(topId);

    const directItems: PublicBookmark[] = [];
    const childBuckets = new Map<string, PublicBookmark[]>();

    for (const item of items) {
      const ids = idsByItem.get(item.id) ?? [];
      if (!ids.includes(topId)) continue;
      // Pick the FIRST matching child tag (sorted by name) so a bookmark
      // attached to both a parent and two children doesn't double-list.
      const childMatches = childIds
        .filter((cid) => ids.includes(cid))
        .map((cid) => tagMap.get(cid)!)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      if (childMatches.length > 0) {
        const primary = childMatches[0];
        const list = childBuckets.get(primary.id) ?? [];
        list.push(item);
        childBuckets.set(primary.id, list);
        usedItemIds.add(item.id);
      } else {
        directItems.push(item);
        usedItemIds.add(item.id);
      }
    }

    const children: DirectoryChildGroup[] = childIds
      .map((cid) => {
        const t = tagMap.get(cid)!;
        const list = childBuckets.get(cid) ?? [];
        return { id: cid, name: t.name, colorIndex: t.colorIndex, items: list };
      })
      .filter((c) => c.items.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    if (directItems.length > 0 || children.length > 0) {
      groups.push({
        id: topId,
        name: top.name,
        colorIndex: top.colorIndex,
        directItems,
        children,
      });
    }
  }

  // Catch-all: items with no recognised tag at all (no tag, or tag-id absent
  // from the graph). Surface them so the directory view is never silently
  // hiding the share author's unlabelled bookmarks.
  const untagged: PublicBookmark[] = [];
  for (const item of items) {
    if (usedItemIds.has(item.id)) continue;
    const ids = idsByItem.get(item.id) ?? [];
    if (ids.length === 0) untagged.push(item);
  }
  if (untagged.length > 0) {
    groups.push({
      id: '__untagged',
      name: '未分类',
      colorIndex: 0,
      directItems: untagged,
      children: [],
    });
  }

  return groups;
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

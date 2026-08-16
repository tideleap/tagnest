import type { Env } from './env';
import type {
  Bookmark,
  BookmarkScope,
  BookmarkSort,
  Collection,
  CollectionBookmarkItem,
  CollectionKind,
  SavedSearchQuery,
} from '../../shared/types';
import { countBookmarks, listBookmarks } from './db';

const SCOPES: BookmarkScope[] = ['inbox', 'all', 'favorites', 'archive', 'trash'];
const SORTS: BookmarkSort[] = [
  'created_desc',
  'created_asc',
  'updated_desc',
  'title_asc',
  'visits_desc',
  'manual',
];

const MAX_QUERY_TAGS = 20;
const MAX_QUERY_Q = 200;

/** Maps a raw `collections` row (+ optional LEFT-JOINED count) to the API DTO. */
export function mapCollection(row: Record<string, unknown>): Collection {
  const kind = (row.kind as CollectionKind) ?? 'manual';
  let query: SavedSearchQuery | null = null;
  if (kind === 'smart' && typeof row.query === 'string' && row.query.length > 0) {
    try {
      query = JSON.parse(row.query as string) as SavedSearchQuery;
    } catch {
      query = null;
    }
  }
  return {
    id: row.id as string,
    name: row.name as string,
    colorIndex: Number(row.color_index ?? 0),
    count: Number(row.count ?? 0),
    kind,
    query,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Maps a joined `bookmarks` row (or a resolved Bookmark) to the minimal item served in a collection. */
export function mapCollectionBookmark(row: Bookmark | Record<string, unknown>): CollectionBookmarkItem {
  const favicon = (row as Record<string, unknown>).faviconUrl ?? (row as Record<string, unknown>).favicon_url;
  return {
    id: row.id as string,
    url: row.url as string,
    title: (row.title as string) ?? '',
    faviconUrl: (favicon as string | null) ?? null,
  };
}

/**
 * Loads a single collection row scoped to the user, with its live bookmark
 * count. Returns null when the id is unknown OR does not belong to the user,
 * so callers can uniformly throw 404 without leaking existence.
 *
 * For `smart` collections `count` is left at 0 here; callers recompute it from
 * the live query (the LEFT JOIN on collection_bookmarks is meaningless for a
 * query-driven collection).
 */
export async function getCollectionRow(
  env: Env,
  userId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(
    `SELECT c.id, c.name, c.color_index, c.kind, c.query, c.created_at, c.updated_at,
            COUNT(cb.bookmark_id) AS count
       FROM collections c
       LEFT JOIN collection_bookmarks cb ON cb.collection_id = c.id
      WHERE c.id = ? AND c.user_id = ?
      GROUP BY c.id`,
  )
    .bind(id, userId)
    .first<Record<string, unknown>>();
}

/**
 * Validates and clamps an untrusted SavedSearchQuery. Out-of-range or invalid
 * values fall back to safe defaults rather than throwing, so a saved search can
 * never break resolution. `tagIds` is capped at 20 and `q` at 200 chars; an
 * empty/whitespace `q` becomes `null`.
 */
export function validateSavedSearchQuery(input: unknown): SavedSearchQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  const q =
    typeof raw.q === 'string' && raw.q.trim().length > 0
      ? raw.q.trim().slice(0, MAX_QUERY_Q)
      : null;
  const tagIds = Array.isArray(raw.tagIds)
    ? (raw.tagIds.filter((t) => typeof t === 'string').slice(0, MAX_QUERY_TAGS) as string[])
    : [];
  const matchAllTags = Boolean(raw.matchAllTags);
  const scope: BookmarkScope =
    typeof raw.scope === 'string' && SCOPES.includes(raw.scope as BookmarkScope)
      ? (raw.scope as BookmarkScope)
      : 'all';
  const sort: BookmarkSort =
    typeof raw.sort === 'string' && SORTS.includes(raw.sort as BookmarkSort)
      ? (raw.sort as BookmarkSort)
      : 'created_desc';
  return { q, tagIds, matchAllTags, scope, sort };
}

/** JSON-encodes a SavedSearchQuery for storage in the `query` column. */
export function serializeSavedSearchQuery(query: SavedSearchQuery): string {
  return JSON.stringify(query);
}

/**
 * Resolves the live members of a `smart` collection by piping its query through
 * the canonical `listBookmarks` engine — scope, privacy, tags and text all
 * apply exactly as a manual search would. Returns the same page shape as the
 * bookmark list so the detail view needs no branching in rendering.
 */
export async function resolveSmartCollectionMembers(
  env: Env,
  userId: string,
  query: SavedSearchQuery,
  opts: { limit?: number; cursor?: string | null } = {},
) {
  return listBookmarks(env, {
    userId,
    scope: query.scope,
    q: query.q,
    tagIds: query.tagIds,
    matchAllTags: query.matchAllTags,
    sort: query.sort,
    cursor: opts.cursor ?? null,
    limit: opts.limit ?? 100,
  });
}

/** Live count of a `smart` collection's members (mirrors resolution exactly). */
export async function countSmartCollection(
  env: Env,
  userId: string,
  query: SavedSearchQuery,
): Promise<number> {
  return countBookmarks(env, {
    userId,
    scope: query.scope,
    q: query.q,
    tagIds: query.tagIds,
    matchAllTags: query.matchAllTags,
    sort: query.sort,
    cursor: null,
    limit: 1,
  });
}

import type { Env } from './env';
import type { Collection, CollectionBookmarkItem } from '../../shared/types';

/** Maps a raw `collections` row (+ optional LEFT-JOINED count) to the API DTO. */
export function mapCollection(row: Record<string, unknown>): Collection {
  return {
    id: row.id as string,
    name: row.name as string,
    colorIndex: Number(row.color_index ?? 0),
    count: Number(row.count ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Maps a joined `bookmarks` row to the minimal item served in a collection. */
export function mapCollectionBookmark(row: Record<string, unknown>): CollectionBookmarkItem {
  return {
    id: row.id as string,
    url: row.url as string,
    title: (row.title as string) ?? '',
    faviconUrl: (row.favicon_url as string | null) ?? null,
  };
}

/**
 * Loads a single collection row scoped to the user, with its live bookmark
 * count. Returns null when the id is unknown OR does not belong to the user,
 * so callers can uniformly throw 404 without leaking existence.
 */
export async function getCollectionRow(
  env: Env,
  userId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(
    `SELECT c.id, c.name, c.color_index, c.created_at, c.updated_at,
            COUNT(cb.bookmark_id) AS count
       FROM collections c
       LEFT JOIN collection_bookmarks cb ON cb.collection_id = c.id
      WHERE c.id = ? AND c.user_id = ?
      GROUP BY c.id`,
  )
    .bind(id, userId)
    .first<Record<string, unknown>>();
}

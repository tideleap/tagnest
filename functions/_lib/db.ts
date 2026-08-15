import type { Bookmark, BookmarkScope, BookmarkSort, PrivateTagBookmark, Tag } from '../../shared/types';
import { TAG_COLOR_COUNT } from '../../shared/types';
import type { Env } from './env';
import { badRequest, conflict } from './http';
import { base64UrlDecode, base64UrlEncode, newId, nowIso } from './ids';
import { canonicalUrl, urlKey } from './urlkey';

/* ------------------------------------------------------------------ *
 * Row mappers
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

const bool = (v: unknown) => v === 1 || v === true;

/* ------------------------------------------------------------------ *
 * D1 parameter-limit-safe IN-clause execution
 * ------------------------------------------------------------------ */

/**
 * Cloudflare D1 caps a single statement at **100 bound parameters**. An
 * `IN (...)` clause therefore holds at most 99 values once we also bind a
 * leading filter such as `user_id = ?`. The import endpoints used to chunk at
 * 400, so any import past ~99 URLs died with
 * `D1_ERROR: too many SQL variables` → HTTP 503 `import_db_unavailable`,
 * i.e. "服务器暂时不可用" on every real-world bookmark file.
 *
 * `D1_IN_CHUNK` = 99 leaves exactly one slot for the leading bound param.
 */
export const D1_MAX_PARAMS = 100;
export const D1_IN_CHUNK = D1_MAX_PARAMS - 1;

/**
 * Clause that hides a user's private bookmarks from every ordinary query.
 *
 * A bookmark is private in either of two ways:
 *   1. it was individually vaulted (`is_private = 1`, encrypted, plaintext
 *      blanked) — the original zero-knowledge path; or
 *   2. it carries at least one tag whose `is_private = 1` — the category-private
 *      path. Hiding is derived in SQL (not materialised per bookmark) so it is
 *      real-time: tagging a bookmark with a private tag hides it instantly, and
 *      unsetting the tag restores it instantly.
 *
 * The only places that should ever see private bookmarks are the dedicated
 * vault endpoints, which query the column explicitly instead of via this.
 * `bt_pv` / `t_pv` are deliberately distinct aliases so this clause never
 * collides with a caller's own `bt` / `t` joins.
 */
export const PRIVATE_BOOKMARK_CLAUSE =
  `b.is_private = 0 AND NOT EXISTS (` +
  `SELECT 1 FROM bookmark_tags bt_pv ` +
  `JOIN tags t_pv ON t_pv.id = bt_pv.tag_id ` +
  `WHERE bt_pv.bookmark_id = b.id AND t_pv.user_id = b.user_id AND t_pv.is_private = 1)`;

/**
 * Runs `makeSql(placeholders)` once per chunk of `values`, binding `leadParams`
 * first and then the chunk, and accumulates every row.
 *
 * @param db            the D1 binding (env.DB)
 * @param values        the list that becomes the IN(...) values
 * @param leadParams    bound *before* the chunk (e.g. `[userId]`)
 * @param makeSql       builds the SQL given the `?, ?, ...` placeholder string
 * @param mapRow        converts a raw row to the desired shape
 */
export async function queryInChunks<T = Row, R = T>(
  db: Env['DB'],
  values: string[],
  leadParams: unknown[],
  makeSql: (placeholders: string) => string,
  mapRow: (row: T) => R,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < values.length; i += D1_IN_CHUNK) {
    const slice = values.slice(i, i + D1_IN_CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = await db
      .prepare(makeSql(placeholders))
      .bind(...leadParams, ...slice)
      .all<T>();
    for (const r of rows.results) out.push(mapRow(r));
  }
  return out;
}


export function mapTag(row: Row): Tag {
  return {
    id: row.id as string,
    name: row.name as string,
    colorIndex: Number(row.color_index ?? 0),
    parentId: (row.parent_id as string | null) ?? null,
    sortOrder: Number(row.sort_order ?? 0),
    count: Number(row.count ?? 0),
    isPrivate: bool(row.is_private),
    createdAt: row.created_at as string,
  };
}

export function mapBookmark(row: Row, tags: Tag[]): Bookmark {
  return {
    id: row.id as string,
    url: row.url as string,
    title: (row.title as string) ?? '',
    description: (row.description as string | null) ?? null,
    faviconUrl: (row.favicon_url as string | null) ?? null,
    coverUrl: (row.cover_url as string | null) ?? null,
    snapshotKey: (row.snapshot_key as string | null) ?? null,
    snapshotKeys: parseSnapshotKeys(row.snapshot_keys),
    note: (row.note as string | null) ?? null,
    aiSummary: (row.ai_summary as string | null) ?? null,
    isFavorite: bool(row.is_favorite),
    isArchived: bool(row.is_archived),
    visitCount: Number(row.visit_count ?? 0),
    lastVisitedAt: (row.last_visited_at as string | null) ?? null,
    manualOrder: Number(row.manual_order ?? 0),
    tags,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

/** Parses the `snapshot_keys` JSON column into a string[], tolerating bad rows. */
export function parseSnapshotKeys(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Serializes an ordered snapshot key list for the `snapshot_keys` column. */
export function serializeSnapshotKeys(keys: string[]): string | null {
  return keys.length > 0 ? JSON.stringify(keys) : null;
}

const BOOKMARK_COLUMNS = `
  b.id, b.url, b.title, b.description, b.favicon_url, b.cover_url, b.snapshot_key,
  b.snapshot_keys, b.note,
  b.ai_summary, b.is_favorite, b.is_archived, b.visit_count, b.last_visited_at,
  b.manual_order, b.created_at, b.updated_at, b.deleted_at
`;

/**
 * Extracts the value the keyset cursor must carry for a given sort column.
 *
 * Driven off the column expression rather than the sort name so the mapping
 * cannot drift from SORTS: adding a sort without extending this function
 * yields a wrong cursor, which the ordering test catches.
 */
function cursorValue(column: string, row: Row): string | number {
  if (column.includes('manual_order')) return Number(row.manual_order ?? 0);
  if (column.includes('created_at')) return row.created_at as string;
  if (column.includes('updated_at')) return row.updated_at as string;
  if (column.includes('visit_count')) return Number(row.visit_count ?? 0);
  return (row.title as string) ?? '';
}

/* ------------------------------------------------------------------ *
 * Tag attachment
 * ------------------------------------------------------------------ */

/**
 * Loads the tags for a page of bookmarks in two queries rather than N.
 *
 * The second query recomputes live usage counts for exactly the tags on this
 * page, so a chip never shows a stale number after a bulk operation.
 */
export async function attachTags(
  env: Env,
  userId: string,
  bookmarkIds: string[],
): Promise<Map<string, Tag[]>> {
  const result = new Map<string, Tag[]>();
  if (bookmarkIds.length === 0) return result;

  // Chunk the bookmark ids exactly like the count query below: callers such as
  // the private-tags listing can pass well over 100 ids, which would overflow
  // D1's 100 bound-parameter cap in a single IN(...).
  const links = await queryInChunks<Row, Row>(
    env.DB,
    bookmarkIds,
    [],
    (ph) =>
      `SELECT bt.bookmark_id, t.id, t.name, t.color_index, t.parent_id, t.sort_order, t.created_at
         FROM bookmark_tags bt
         JOIN tags t ON t.id = bt.tag_id
        WHERE bt.bookmark_id IN (${ph})
        ORDER BY t.sort_order, t.name COLLATE NOCASE`,
    (r) => r,
  );

  const tagIds = [...new Set(links.map((r) => r.id as string))];
  const counts = new Map<string, number>();

  if (tagIds.length > 0) {
    // The per-tag usage count must stay within D1's 100 bound-param limit for a
    // single statement. A page of 100 bookmarks, each with a distinct tag, would
    // overflow `IN (...)`; chunk the tag-id list exactly like ensureTags does.
    const countRows = await queryInChunks<Row, Row>(
      env.DB,
      tagIds,
      [userId],
      (ph) => `SELECT bt.tag_id, COUNT(*) AS c
                 FROM bookmark_tags bt
                 JOIN bookmarks b ON b.id = bt.bookmark_id
                WHERE b.user_id = ? AND b.deleted_at IS NULL
                  AND bt.tag_id IN (${ph})
                GROUP BY bt.tag_id`,
      (r) => r,
    );
    for (const r of countRows) counts.set(r.tag_id as string, Number(r.c));
  }

  for (const row of links) {
    const id = row.bookmark_id as string;
    const list = result.get(id) ?? [];
    list.push(mapTag({ ...row, count: counts.get(row.id as string) ?? 0 }));
    result.set(id, list);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Tag creation
 * ------------------------------------------------------------------ */

/**
 * Maps tag names to IDs, creating any that do not exist.
 *
 * Matching is case-insensitive so "Rust" typed twice with different casing
 * resolves to one tag; the first spelling wins.
 */
export async function ensureTags(
  env: Env,
  userId: string,
  names: string[],
): Promise<{ ids: string[]; created: number }> {
  const cleaned = [
    ...new Map(
      names
        .map((n) => n.trim().replace(/\s+/g, ' '))
        .filter((n) => n.length > 0 && n.length <= 60)
        .map((n) => [n.toLowerCase(), n]),
    ).values(),
  ];
  if (cleaned.length === 0) return { ids: [], created: 0 };

  const existing = await queryInChunks<Row, Row>(
    env.DB,
    cleaned,
    [userId],
    (ph) => `SELECT id, name FROM tags WHERE user_id = ? AND name COLLATE NOCASE IN (${ph})`,
    (r) => r,
  );

  const byLower = new Map(
    existing.map((r) => [(r.name as string).toLowerCase(), r.id as string]),
  );

  const ids: string[] = [];
  const inserts: D1PreparedStatement[] = [];
  const ts = nowIso();

  for (const name of cleaned) {
    const hit = byLower.get(name.toLowerCase());
    if (hit) {
      ids.push(hit);
      continue;
    }
    const id = newId();
    ids.push(id);
    inserts.push(
      env.DB.prepare(
        `INSERT INTO tags (id, user_id, name, color_index, parent_id, sort_order, created_at)
         VALUES (?, ?, ?, ?, NULL, 0, ?)`,
      ).bind(id, userId, name, colorForName(name), ts),
    );
  }

  // Flush in groups of 90 so an import that mints >100 new tags at once never
  // trips D1's 100-statement batch cap.
  const BATCH_LIMIT = 90;
  for (let i = 0; i < inserts.length; i += BATCH_LIMIT) {
    await env.DB.batch(inserts.slice(i, i + BATCH_LIMIT));
  }
  return { ids, created: inserts.length };
}

/**
 * Deterministic palette assignment.
 *
 * A hash of the name means the same tag gets the same colour on every device
 * and after every import, without storing a global counter.
 */
export function colorForName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % TAG_COLOR_COUNT;
}

export async function setBookmarkTags(env: Env, bookmarkId: string, tagIds: string[]) {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM bookmark_tags WHERE bookmark_id = ?`).bind(bookmarkId),
  ];
  for (const tagId of tagIds) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)`,
      ).bind(bookmarkId, tagId),
    );
  }
  await env.DB.batch(statements);
}

/* ------------------------------------------------------------------ *
 * Keyset pagination
 * ------------------------------------------------------------------ */

interface SortSpec {
  /** SQL expression the cursor compares against. */
  column: string;
  direction: 'ASC' | 'DESC';
}

export const SORTS: Record<BookmarkSort, SortSpec> = {
  created_desc: { column: 'b.created_at', direction: 'DESC' },
  created_asc: { column: 'b.created_at', direction: 'ASC' },
  updated_desc: { column: 'b.updated_at', direction: 'DESC' },
  title_asc: { column: 'b.title COLLATE NOCASE', direction: 'ASC' },
  visits_desc: { column: 'b.visit_count', direction: 'DESC' },
  // Drag order. Positioned rows carry a large sparse value and sort first;
  // everything still at the 0 default falls to the bottom, where the id
  // tiebreaker (time-prefixed) keeps it in newest-first order.
  manual: { column: 'b.manual_order', direction: 'DESC' },
};

interface Cursor {
  v: string | number;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(c)));
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(raw))) as Cursor;
    if (parsed && (typeof parsed.v === 'string' || typeof parsed.v === 'number') && typeof parsed.id === 'string') {
      return parsed;
    }
  } catch {
    /* falls through */
  }
  throw badRequest('分页游标无效');
}

/* ------------------------------------------------------------------ *
 * Bookmark listing
 * ------------------------------------------------------------------ */

export interface ListParams {
  userId: string;
  scope: BookmarkScope;
  q: string | null;
  tagIds: string[];
  matchAllTags: boolean;
  sort: BookmarkSort;
  cursor: string | null;
  limit: number;
}

interface ScopeClause {
  sql: string;
  params: unknown[];
}

function scopeClause(scope: BookmarkScope): ScopeClause {
  switch (scope) {
    case 'trash':
      return { sql: 'b.deleted_at IS NOT NULL', params: [] };
    case 'favorites':
      return { sql: 'b.deleted_at IS NULL AND b.is_favorite = 1', params: [] };
    case 'archive':
      return { sql: 'b.deleted_at IS NULL AND b.is_archived = 1', params: [] };
    case 'inbox':
      // Inbox is "not yet filed": live, not archived, and carrying no tags.
      return {
        sql: `b.deleted_at IS NULL AND b.is_archived = 0
              AND NOT EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id)`,
        params: [],
      };
    case 'all':
    default:
      return { sql: 'b.deleted_at IS NULL AND b.is_archived = 0', params: [] };
  }
}

/**
 * Search strategy.
 *
 * Trigram FTS needs at least three characters, so shorter queries — very
 * common in Chinese, where two characters is a whole word — fall back to LIKE.
 * The caller also retries with LIKE if MATCH throws, which keeps the endpoint
 * working on any SQLite build without the trigram tokenizer.
 */
function searchClause(q: string, useFts: boolean): ScopeClause {
  if (useFts) {
    return {
      sql: `b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)`,
      // Quoting makes the whole string one trigram phrase, so punctuation in
      // the query cannot be read as FTS5 operator syntax.
      params: [`"${q.replace(/"/g, '""')}"`],
    };
  }
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return {
    sql: `(b.title LIKE ?1 ESCAPE '\\' OR b.url LIKE ?1 ESCAPE '\\'
           OR COALESCE(b.description,'') LIKE ?1 ESCAPE '\\'
           OR COALESCE(b.note,'') LIKE ?1 ESCAPE '\\')`,
    params: [like],
  };
}

export function buildWhere(p: ListParams, useFts: boolean): ScopeClause {
  const parts = ['b.user_id = ?', PRIVATE_BOOKMARK_CLAUSE];
  const params: unknown[] = [p.userId];

  const scope = scopeClause(p.scope);
  parts.push(`(${scope.sql})`);
  params.push(...scope.params);

  if (p.tagIds.length > 0) {
    const ph = p.tagIds.map(() => '?').join(',');
    if (p.matchAllTags) {
      parts.push(
        `(SELECT COUNT(DISTINCT bt.tag_id) FROM bookmark_tags bt
           WHERE bt.bookmark_id = b.id AND bt.tag_id IN (${ph})) = ?`,
      );
      params.push(...p.tagIds, p.tagIds.length);
    } else {
      parts.push(
        `EXISTS (SELECT 1 FROM bookmark_tags bt
                  WHERE bt.bookmark_id = b.id AND bt.tag_id IN (${ph}))`,
      );
      params.push(...p.tagIds);
    }
  }

  if (p.q) {
    // The LIKE branch uses ?1, which would clash with positional binding in a
    // larger statement, so it is rendered with its own parameter list inline.
    const search = searchClause(p.q, useFts);
    if (useFts) {
      parts.push(search.sql);
      params.push(...search.params);
    } else {
      const like = search.params[0];
      parts.push(
        `(b.title LIKE ? ESCAPE '\\' OR b.url LIKE ? ESCAPE '\\'
          OR COALESCE(b.description,'') LIKE ? ESCAPE '\\'
          OR COALESCE(b.note,'') LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like, like, like);
    }
  }

  return { sql: parts.join(' AND '), params };
}

async function runList(env: Env, p: ListParams, useFts: boolean) {
  const where = buildWhere(p, useFts);
  const spec = SORTS[p.sort] ?? SORTS.created_desc;

  const clauses = [where.sql];
  const params = [...where.params];

  if (p.cursor) {
    const cursor = decodeCursor(p.cursor);
    const cmp = spec.direction === 'DESC' ? '<' : '>';
    // Compare on (sort value, id) so rows sharing a timestamp are not skipped
    // or repeated across page boundaries.
    clauses.push(`(${spec.column} ${cmp} ? OR (${spec.column} = ? AND b.id ${cmp} ?))`);
    params.push(cursor.v, cursor.v, cursor.id);
  }

  const sql = `
    SELECT ${BOOKMARK_COLUMNS}
      FROM bookmarks b
     WHERE ${clauses.join(' AND ')}
     ORDER BY ${spec.column} ${spec.direction}, b.id ${spec.direction}
     LIMIT ?`;

  const rows = await env.DB.prepare(sql)
    .bind(...params, p.limit + 1)
    .all<Row>();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookmarks b WHERE ${where.sql}`,
  )
    .bind(...where.params)
    .first<{ c: number }>();

  return { rows: rows.results, total: Number(total?.c ?? 0), spec };
}

export async function listBookmarks(env: Env, p: ListParams) {
  const useFts = Boolean(p.q && [...p.q].length >= 3);

  let result: Awaited<ReturnType<typeof runList>>;
  try {
    result = await runList(env, p, useFts);
  } catch (e) {
    if (!useFts) throw e;
    // Malformed FTS expression or a build without the trigram tokenizer.
    console.warn('[tagnest] FTS query failed, falling back to LIKE', e);
    result = await runList(env, p, false);
  }

  const { rows, total, spec } = result;
  const hasMore = rows.length > p.limit;
  const page = hasMore ? rows.slice(0, p.limit) : rows;

  const tagMap = await attachTags(
    env,
    p.userId,
    page.map((r) => r.id as string),
  );

  const items = page.map((r) => mapBookmark(r, tagMap.get(r.id as string) ?? []));

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1];
    nextCursor = encodeCursor({ v: cursorValue(spec.column, last), id: last.id as string });
  }

  return { items, nextCursor, total };
}

export async function loadBookmark(
  env: Env,
  userId: string,
  id: string,
): Promise<Bookmark | null> {
  const row = await env.DB.prepare(
    `SELECT ${BOOKMARK_COLUMNS} FROM bookmarks b
      WHERE b.id = ? AND b.user_id = ? AND ${PRIVATE_BOOKMARK_CLAUSE} LIMIT 1`,
  )
    .bind(id, userId)
    .first<Row>();
  if (!row) return null;
  const tags = await attachTags(env, userId, [id]);
  return mapBookmark(row, tags.get(id) ?? []);
}

/**
 * Loads the JSON `snapshot_keys` list for a bookmark (oldest → newest), plus
 * its current latest `snapshot_key`. Used by the snapshot pipeline to append a
 * new capture and run retention pruning. Returns null when the bookmark is not
 * found.
 */
export async function loadSnapshotState(
  env: Env,
  userId: string,
  bookmarkId: string,
): Promise<{ snapshotKey: string | null; snapshotKeys: string[] } | null> {
  const row = await env.DB.prepare(
    `SELECT snapshot_key, snapshot_keys FROM bookmarks WHERE id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(bookmarkId, userId)
    .first<Row>();
  if (!row) return null;
  return {
    snapshotKey: (row.snapshot_key as string | null) ?? null,
    snapshotKeys: parseSnapshotKeys(row.snapshot_keys),
  };
}

export interface SnapshotMonitorRow {
  id: string;
  url: string;
  title: string;
  snapshotKey: string;
  snapshotKeys: string[];
  visitCount: number;
  lastVisitedAt: string | null;
}

/**
 * Returns the user's live bookmarks that already have at least one snapshot.
 *
 * Ordered by "most interesting first": visits desc, then latest capture desc,
 * then title. This keeps the monitor strip focused on sites the user actually
 * cares about, rather than the newest imports that may never have been opened.
 */
export async function listBookmarksWithSnapshots(
  env: Env,
  userId: string,
  limit: number,
): Promise<SnapshotMonitorRow[]> {
  const rows = await env.DB.prepare(
    `SELECT b.id, b.url, b.title, b.snapshot_key, b.snapshot_keys,
            b.visit_count, b.last_visited_at
       FROM bookmarks b
      WHERE b.user_id = ?
        AND b.deleted_at IS NULL
        AND b.is_archived = 0
        AND ${PRIVATE_BOOKMARK_CLAUSE}
        AND b.snapshot_key IS NOT NULL
      ORDER BY b.visit_count DESC,
               json_extract(b.snapshot_keys, '$[#-1]') DESC,
               b.title COLLATE NOCASE ASC
      LIMIT ?`,
  )
    .bind(userId, limit)
    .all<Row>();

  return rows.results.map((row) => ({
    id: row.id as string,
    url: row.url as string,
    title: (row.title as string) ?? '',
    snapshotKey: row.snapshot_key as string,
    snapshotKeys: parseSnapshotKeys(row.snapshot_keys),
    visitCount: Number(row.visit_count ?? 0),
    lastVisitedAt: (row.last_visited_at as string | null) ?? null,
  }));
}

/**
 * Generic field update used by both ordinary and vault-only bookmark edits.
 * The caller must already have verified ownership and privacy scope; this
 * helper only writes columns and (optionally) replaces tags.
 */
export async function updateBookmarkFields(
  env: Env,
  userId: string,
  id: string,
  patch: {
    url?: string;
    title?: string;
    description?: string | null;
    note?: string | null;
    faviconUrl?: string | null;
    coverUrl?: string | null;
    isFavorite?: boolean;
    isArchived?: boolean;
    tagNames?: string[];
  },
): Promise<Bookmark | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  const text = (value: string | null | undefined, column: string, max: number) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    params.push(value === null || value === '' ? null : String(value).slice(0, max));
  };

  if (patch.url !== undefined) {
    sets.push('url = ?', 'url_key = ?');
    params.push(patch.url, urlKey(patch.url));
  }

  text(patch.title, 'title', 300);
  text(patch.description, 'description', 2000);
  text(patch.note, 'note', 20000);
  text(patch.faviconUrl, 'favicon_url', 500);
  text(patch.coverUrl, 'cover_url', 500);

  if (patch.isFavorite !== undefined) {
    sets.push('is_favorite = ?');
    params.push(patch.isFavorite ? 1 : 0);
  }
  if (patch.isArchived !== undefined) {
    sets.push('is_archived = ?');
    params.push(patch.isArchived ? 1 : 0);
  }

  if (sets.length === 0 && !patch.tagNames) {
    return loadBookmark(env, userId, id);
  }

  if (sets.length > 0) {
    sets.push('updated_at = ?');
    params.push(nowIso(), id, userId);
    await env.DB.prepare(`UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...params)
      .run();
  }

  if (patch.tagNames !== undefined) {
    const { ids } = await ensureTags(env, userId, patch.tagNames.slice(0, 30));
    await setBookmarkTags(env, id, ids);
  }

  return loadBookmark(env, userId, id);
}


/**
 * Persists the snapshot state after a capture: the latest key (for the card's
 * `snapshot_key`) and the full retained list (`snapshot_keys`, oldest→newest).
 * Consistent update of both columns in one statement avoids a torn state.
 */
export async function updateBookmarkSnapshots(
  env: Env,
  userId: string,
  bookmarkId: string,
  latestKey: string,
  snapshotKeys: string[],
): Promise<void> {
  await env.DB.prepare(
    `UPDATE bookmarks
        SET snapshot_key = ?, snapshot_keys = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`,
  )
    .bind(latestKey, serializeSnapshotKeys(snapshotKeys), nowIso(), bookmarkId, userId)
    .run();
}

/**
 * A bookmark's snapshot references as stored in the DB — used by the snapshot
 * maintenance scan. `latestKey` is the single `snapshot_key` (newest), while
 * `snapshotKeys` is the retained history (oldest → newest).
 */
export interface BookmarkSnapshotRefs {
  id: string;
  latestKey: string | null;
  snapshotKeys: string[];
}

/**
 * Loads every bookmark's snapshot references for a user (both live and trashed,
 * so cleanup can reconcile the whole history even for soft-deleted items).
 *
 * Excludes only the encrypted zero-knowledge vault (`is_private = 1`); it does
 * NOT apply `PRIVATE_BOOKMARK_CLAUSE`, because that clause also hides
 * category-private bookmarks (plaintext, merely hidden by a private tag). Those
 * share the normal snapshot lifecycle and R2 bucket with ordinary bookmarks, so
 * leaving them out of the scan would let dangling snapshot references on them
 * accumulate unreconciled. Vault bookmarks are excluded because their blob
 * semantics differ and they are reconciled through the vault path instead.
 */
export async function loadAllBookmarkSnapshotRefs(
  env: Env,
  userId: string,
): Promise<BookmarkSnapshotRefs[]> {
  const rows = await env.DB.prepare(
    `SELECT id, snapshot_key, snapshot_keys FROM bookmarks b
      WHERE b.user_id = ? AND b.is_private = 0
        AND (b.snapshot_key IS NOT NULL OR b.snapshot_keys IS NOT NULL)`,
  )
    .bind(userId)
    .all<Row>();
  return rows.results.map((r) => ({
    id: r.id as string,
    latestKey: (r.snapshot_key as string | null) ?? null,
    snapshotKeys: parseSnapshotKeys(r.snapshot_keys),
  }));
}

/** Reads the user's snapshot retention limit (default 5; -1 = unlimited). */
export async function loadSnapshotRetentionLimit(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT snapshot_retention_limit FROM user_settings WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ snapshot_retention_limit: number | null }>();
  const n = Number(row?.snapshot_retention_limit);
  if (Number.isInteger(n) && (n === -1 || n >= 1)) return n;
  return 5;
}

/* ------------------------------------------------------------------ *
 * Private (encrypted) bookmarks — the zero-knowledge vault
 *
 * These functions deliberately bypass PRIVATE_BOOKMARK_CLAUSE: they are the
 * only code paths allowed to read or write private rows, and they exist behind
 * dedicated /api/private endpoints. Every other reader in this file filters
 * private rows out via PRIVATE_BOOKMARK_CLAUSE.
 * ------------------------------------------------------------------ */

/** A private bookmark as returned to the (already unlocked) client: only the
 * ciphertext plus non-sensitive flags — never plaintext. */
export interface PrivateBookmarkRow {
  id: string;
  encryptedBlob: string;
  isFavorite: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Fields the client sends back when cancelling privacy (restoring a bookmark). */
export interface RestoredBookmarkFields {
  url: string;
  title: string;
  description: string | null;
  note: string | null;
  faviconUrl: string | null;
  coverUrl: string | null;
  tagNames: string[];
}

const PRIVATE_COLUMNS = `
  b.id, b.encrypted_blob, b.is_favorite, b.is_archived,
  b.created_at, b.updated_at
`;

/** Lists a user's private bookmarks (ciphertext only), newest first. */
export async function listPrivateBookmarkRows(env: Env, userId: string): Promise<PrivateBookmarkRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ${PRIVATE_COLUMNS}
       FROM bookmarks b
      WHERE b.user_id = ? AND b.is_private = 1 AND b.deleted_at IS NULL
      ORDER BY b.created_at DESC`,
  )
    .bind(userId)
    .all<Row>();
  return rows.results.map((r) => ({
    id: r.id as string,
    encryptedBlob: (r.encrypted_blob as string) ?? '',
    isFavorite: bool(r.is_favorite),
    isArchived: bool(r.is_archived),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

/** Loads a single private bookmark (ciphertext only), or null. */
export async function loadPrivateBookmarkRow(
  env: Env,
  userId: string,
  id: string,
): Promise<PrivateBookmarkRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${PRIVATE_COLUMNS}
       FROM bookmarks b
      WHERE b.id = ? AND b.user_id = ? AND b.is_private = 1 LIMIT 1`,
  )
    .bind(id, userId)
    .first<Row>();
  if (!row) return null;
  return {
    id: row.id as string,
    encryptedBlob: (row.encrypted_blob as string) ?? '',
    isFavorite: bool(row.is_favorite),
    isArchived: bool(row.is_archived),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Marks a live bookmark private: blanks its readable columns, stores the
 * client-supplied ciphertext, and removes its tag links so the bookmark cannot
 * surface in any tag view, share, or count. The row's `url_key` is rewritten to
 * a per-bookmark constant to keep the (user_id, url_key) unique index happy.
 */
export async function setBookmarkPrivate(
  env: Env,
  userId: string,
  id: string,
  encryptedBlob: string,
): Promise<boolean> {
  const ts = nowIso();
  const res = await env.DB.prepare(
    `UPDATE bookmarks
        SET is_private = 1,
            url = '',
            url_key = ?,
            title = '',
            description = NULL,
            favicon_url = NULL,
            cover_url = NULL,
            note = NULL,
            encrypted_blob = ?,
            updated_at = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND is_private = 0`,
  )
    .bind(`private:${id}`, encryptedBlob, ts, id, userId)
    .run();
  if (Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) return false;
  // Drop tag links so the private bookmark is invisible to the tag system.
  await env.DB.prepare(`DELETE FROM bookmark_tags WHERE bookmark_id = ?`).bind(id).run();
  return true;
}

/**
 * Restores a private bookmark to a normal, visible one. The client supplies the
 * decrypted plaintext (it just unlocked the vault), which we write back and
 * re-link to its original tags by name. A URL that now collides with another
 * live bookmark is reported as a conflict, exactly like editing a URL.
 */
export async function clearBookmarkPrivate(
  env: Env,
  userId: string,
  id: string,
  fields: RestoredBookmarkFields,
): Promise<Bookmark | null> {
  // The plaintext arrives from the client, so it is re-validated here rather
  // than trusted: an unparseable URL would otherwise write a NULL url column
  // and produce a bookmark that can never be opened again.
  const url = canonicalUrl(fields.url);
  if (!url) throw badRequest('网址格式不正确', { url: '网址格式不正确' });
  const key = urlKey(url);
  const clash = await env.DB.prepare(
    `SELECT id FROM bookmarks
      WHERE user_id = ? AND url_key = ? AND deleted_at IS NULL AND id <> ? LIMIT 1`,
  )
    .bind(userId, key, id)
    .first<{ id: string }>();
  if (clash) throw conflict('该网址已在书签库中', { id: clash.id });

  const ts = nowIso();
  await env.DB.prepare(
    `UPDATE bookmarks
        SET is_private = 0,
            url = ?,
            url_key = ?,
            title = ?,
            description = ?,
            favicon_url = ?,
            cover_url = ?,
            note = ?,
            encrypted_blob = NULL,
            updated_at = ?
      WHERE id = ? AND user_id = ? AND is_private = 1`,
  )
    .bind(
      url,
      key,
      fields.title.slice(0, 300),
      fields.description ? fields.description.slice(0, 2000) : null,
      fields.faviconUrl ? fields.faviconUrl.slice(0, 500) : null,
      fields.coverUrl ? fields.coverUrl.slice(0, 500) : null,
      fields.note ? fields.note.slice(0, 20000) : null,
      ts,
      id,
      userId,
    )
    .run();

  if (fields.tagNames.length > 0) {
    const { ids } = await ensureTags(env, userId, fields.tagNames.slice(0, 30));
    await setBookmarkTags(env, id, ids);
  }

  return loadBookmark(env, userId, id);
}

/**
 * Sets or clears a tag's private flag, cascading to every descendant tag so a
 * "big category" private toggle hides (or restores) the whole subtree at once.
 *
 * Because hiding is derived in SQL (`PRIVATE_BOOKMARK_CLAUSE`), no bookmark row
 * is touched — visibility updates in real time: a bookmark tagged with a
 * private tag disappears from every list/search/share/export instantly, and
 * unsetting the tag makes it reappear instantly. `UNION` (not `UNION ALL`)
 * de-duplicates, which also terminates safely should the tree ever contain a
 * cycle. Returns the number of tags (root included) whose flag changed.
 */
export async function setTagPrivate(
  env: Env,
  userId: string,
  tagId: string,
  isPrivate: boolean,
): Promise<number> {
  const flag = isPrivate ? 1 : 0;
  const ts = nowIso();
  const res = await env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT ?
       UNION
       SELECT t.id FROM tags t JOIN sub ON t.parent_id = sub.id WHERE t.user_id = ?
     )
     UPDATE tags SET is_private = ?, updated_at = ?
     WHERE id IN (SELECT id FROM sub) AND user_id = ?`,
  )
    .bind(tagId, userId, flag, ts, userId)
    .run();
  return Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

/**
 * Lists every private tag for a user together with the plaintext bookmarks each
 * one currently hides. Powers the authorized-only listing at GET /api/private/tags.
 *
 * This is a vault path, so it deliberately does NOT filter through
 * `PRIVATE_BOOKMARK_CLAUSE` — its entire job is to surface what that clause
 * hides. Two guards keep the payload safe/honest:
 *   - only bookmarks whose own plaintext is still readable (`is_private = 0`,
 *     i.e. NOT individually vaulted) are returned, so the encrypted-blob path
 *     never leaks decrypted content;
 *   - trashed bookmarks (`deleted_at IS NOT NULL`) are excluded.
 * The per-tag `count` mirrors `mapTag`'s live-usage semantics (readable,
 * non-trashed members) rather than the raw `bookmark_tags` row count.
 */
export async function listPrivateTagsWithBookmarks(
  env: Env,
  userId: string,
  q?: string,
): Promise<Array<{ tag: Tag; bookmarks: PrivateTagBookmark[] }>> {
  const normalizedQ = q?.trim().toLowerCase();

  const tagRows = await env.DB.prepare(
    `SELECT t.id, t.name, t.color_index, t.parent_id, t.sort_order, t.is_private, t.created_at,
            (SELECT COUNT(*) FROM bookmark_tags bt
               JOIN bookmarks b ON b.id = bt.bookmark_id
              WHERE bt.tag_id = t.id AND b.user_id = ? AND b.deleted_at IS NULL AND b.is_private = 0
                ${normalizedQ ? `AND (LOWER(b.title) LIKE ? OR LOWER(b.url) LIKE ? OR (b.note IS NOT NULL AND LOWER(b.note) LIKE ?))` : ''}
            ) AS count
       FROM tags t
      WHERE t.user_id = ? AND t.is_private = 1
      ORDER BY t.sort_order, t.name COLLATE NOCASE`,
  )
    .bind(
      userId,
      ...(normalizedQ
        ? [`%${normalizedQ}%`, `%${normalizedQ}%`, `%${normalizedQ}%`]
        : []),
      userId,
    )
    .all<Row>();

  // One query fetches every (private tag → bookmark) pair at once, replacing the
  // previous loop that issued one query per private tag (an N+1 against the tag
  // count). The pairs are then grouped in memory by tag, which is cheap next to
  // a round-trip per tag. Tag ordering still follows the first query; bookmark
  // ordering within a tag follows `b.title`, exactly as before.
  const bmParams: unknown[] = [userId, userId];
  let bmWhere = `t.user_id = ? AND t.is_private = 1
       AND b.user_id = ? AND b.deleted_at IS NULL AND b.is_private = 0`;
  if (normalizedQ) {
    bmWhere += ` AND (LOWER(b.title) LIKE ? OR LOWER(b.url) LIKE ? OR (b.note IS NOT NULL AND LOWER(b.note) LIKE ?))`;
    bmParams.push(`%${normalizedQ}%`, `%${normalizedQ}%`, `%${normalizedQ}%`);
  }

  const bmPairs = await env.DB.prepare(
    `SELECT DISTINCT bt.tag_id AS tag_id, b.id, b.url, b.title, b.favicon_url, b.note,
            b.is_favorite, b.is_archived, b.created_at
       FROM bookmarks b
       JOIN bookmark_tags bt ON bt.bookmark_id = b.id
       JOIN tags t ON t.id = bt.tag_id
      WHERE ${bmWhere}
      ORDER BY b.title COLLATE NOCASE`,
  )
    .bind(...bmParams)
    .all<Row>();

  const bookmarksByTag = new Map<string, PrivateTagBookmark[]>();
  const allIds: string[] = [];
  for (const r of bmPairs.results) {
    const tagId = r.tag_id as string;
    const id = r.id as string;
    const list = bookmarksByTag.get(tagId) ?? [];
    list.push({
      id,
      url: r.url as string,
      title: (r.title as string) ?? '',
      faviconUrl: (r.favicon_url as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      isFavorite: bool(r.is_favorite),
      isArchived: bool(r.is_archived),
      createdAt: r.created_at as string,
      tags: [],
    });
    bookmarksByTag.set(tagId, list);
    allIds.push(id);
  }

  const entries: Array<{ tag: Tag; bookmarks: PrivateTagBookmark[] }> = [];
  for (const tagRow of tagRows.results) {
    const tag = mapTag(tagRow);
    entries.push({ tag, bookmarks: bookmarksByTag.get(tag.id) ?? [] });
  }

  if (allIds.length > 0) {
    const tagsByBm = await attachTags(env, userId, [...new Set(allIds)]);
    for (const entry of entries) {
      for (const bm of entry.bookmarks) {
        bm.tags = tagsByBm.get(bm.id) ?? [];
      }
    }
  }

  // When searching, omit tags whose filter left no bookmarks.
  return normalizedQ ? entries.filter((e) => e.bookmarks.length > 0) : entries;
}

/**
 * Determines whether a bookmark is currently hidden by at least one private tag
 * belonging to the user. Used by vault-only endpoints to gate access to rows
 * that ordinary paths filter out via `PRIVATE_BOOKMARK_CLAUSE`.
 */
export async function isBookmarkHiddenByPrivateTag(
  env: Env,
  userId: string,
  bookmarkId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM bookmark_tags bt
       JOIN tags t ON t.id = bt.tag_id
      WHERE bt.bookmark_id = ? AND t.user_id = ? AND t.is_private = 1 LIMIT 1`,
  )
    .bind(bookmarkId, userId)
    .first<Row>();
  return row !== null;
}

/**
 * Loads a single bookmark that is hidden from ordinary views because it carries
 * a private tag. Returns `null` if the bookmark does not exist, is individually
 * vaulted (`is_private = 1`), is trashed, or is not hidden by a private tag.
 * This is the vault path counterpart to `loadBookmark`.
 */
export async function loadPrivateTagBookmark(
  env: Env,
  userId: string,
  id: string,
): Promise<Bookmark | null> {
  const hidden = await isBookmarkHiddenByPrivateTag(env, userId, id);
  if (!hidden) return null;
  const row = await env.DB.prepare(
    `SELECT ${BOOKMARK_COLUMNS} FROM bookmarks b
      WHERE b.id = ? AND b.user_id = ? AND b.is_private = 0 AND b.deleted_at IS NULL LIMIT 1`,
  )
    .bind(id, userId)
    .first<Row>();
  if (!row) return null;
  const tags = await attachTags(env, userId, [id]);
  return mapBookmark(row, tags.get(id) ?? []);
}

/** Creates a brand-new private bookmark directly inside the vault. */
export async function createPrivateBookmark(
  env: Env,
  userId: string,
  encryptedBlob: string,
  isFavorite: boolean,
  isArchived: boolean,
): Promise<string> {
  const id = newId();
  const ts = nowIso();
  await env.DB.prepare(
    `INSERT INTO bookmarks
       (id, user_id, url, url_key, title, description, favicon_url, cover_url, note,
        ai_summary, is_favorite, is_archived, is_private, encrypted_blob,
        visit_count, last_visited_at, created_at, updated_at, deleted_at)
     VALUES (?, ?, '', ?, '', NULL, NULL, NULL, NULL, NULL, ?, ?, 1, ?, 0, NULL, ?, ?, NULL)`,
  )
    .bind(
      id,
      userId,
      `private:${id}`,
      isFavorite ? 1 : 0,
      isArchived ? 1 : 0,
      encryptedBlob,
      ts,
      ts,
    )
    .run();
  return id;
}

/** Re-encrypts an existing private bookmark's payload. */
export async function updatePrivateBookmark(
  env: Env,
  userId: string,
  id: string,
  encryptedBlob: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE bookmarks SET encrypted_blob = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND is_private = 1`,
  )
    .bind(encryptedBlob, nowIso(), id, userId)
    .run();
  return Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

/** Permanently deletes a private bookmark. */
export async function deletePrivateBookmark(env: Env, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM bookmarks WHERE id = ? AND user_id = ? AND is_private = 1`,
  )
    .bind(id, userId)
    .run();
  return Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

import type { Bookmark, BookmarkScope, BookmarkSort, Tag } from '../../shared/types';
import { TAG_COLOR_COUNT } from '../../shared/types';
import type { Env } from './env';
import { badRequest } from './http';
import { base64UrlDecode, base64UrlEncode, newId, nowIso } from './ids';

/* ------------------------------------------------------------------ *
 * Row mappers
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

const bool = (v: unknown) => v === 1 || v === true;

export function mapTag(row: Row): Tag {
  return {
    id: row.id as string,
    name: row.name as string,
    colorIndex: Number(row.color_index ?? 0),
    parentId: (row.parent_id as string | null) ?? null,
    sortOrder: Number(row.sort_order ?? 0),
    count: Number(row.count ?? 0),
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

const BOOKMARK_COLUMNS = `
  b.id, b.url, b.title, b.description, b.favicon_url, b.cover_url, b.note,
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

  const placeholders = bookmarkIds.map(() => '?').join(',');

  const links = await env.DB.prepare(
    `SELECT bt.bookmark_id, t.id, t.name, t.color_index, t.parent_id, t.sort_order, t.created_at
       FROM bookmark_tags bt
       JOIN tags t ON t.id = bt.tag_id
      WHERE bt.bookmark_id IN (${placeholders})
      ORDER BY t.sort_order, t.name COLLATE NOCASE`,
  )
    .bind(...bookmarkIds)
    .all<Row>();

  const tagIds = [...new Set(links.results.map((r) => r.id as string))];
  const counts = new Map<string, number>();

  if (tagIds.length > 0) {
    const countRows = await env.DB.prepare(
      `SELECT bt.tag_id, COUNT(*) AS c
         FROM bookmark_tags bt
         JOIN bookmarks b ON b.id = bt.bookmark_id
        WHERE b.user_id = ? AND b.deleted_at IS NULL
          AND bt.tag_id IN (${tagIds.map(() => '?').join(',')})
        GROUP BY bt.tag_id`,
    )
      .bind(userId, ...tagIds)
      .all<Row>();
    for (const r of countRows.results) counts.set(r.tag_id as string, Number(r.c));
  }

  for (const row of links.results) {
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

  const existing = await env.DB.prepare(
    `SELECT id, name FROM tags
      WHERE user_id = ? AND name COLLATE NOCASE IN (${cleaned.map(() => '?').join(',')})`,
  )
    .bind(userId, ...cleaned)
    .all<Row>();

  const byLower = new Map(
    existing.results.map((r) => [(r.name as string).toLowerCase(), r.id as string]),
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

  if (inserts.length > 0) await env.DB.batch(inserts);
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

function buildWhere(p: ListParams, useFts: boolean): ScopeClause {
  const parts = ['b.user_id = ?'];
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
    `SELECT ${BOOKMARK_COLUMNS} FROM bookmarks b WHERE b.id = ? AND b.user_id = ? LIMIT 1`,
  )
    .bind(id, userId)
    .first<Row>();
  if (!row) return null;
  const tags = await attachTags(env, userId, [id]);
  return mapBookmark(row, tags.get(id) ?? []);
}

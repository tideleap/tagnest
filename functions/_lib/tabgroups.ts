import type { Env } from './env';
import { badRequest } from './http';
import { newId, nowIso } from './ids';

/* ------------------------------------------------------------------ *
 * Row mappers
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

export interface TabGroup {
  id: string;
  name: string;
  colorIndex: number;
  sortOrder: number;
  /** Number of bookmarks currently in the group. */
  count: number;
  createdAt: string;
  updatedAt: string;
}

export interface TabItemBookmark {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
}

export interface TabItem {
  id: string;
  groupId: string;
  bookmarkId: string;
  position: number;
  bookmark: TabItemBookmark;
  createdAt: string;
}

export function mapTabGroup(row: Row, count = 0): TabGroup {
  return {
    id: row.id as string,
    name: row.name as string,
    colorIndex: Number(row.color_index ?? 0),
    sortOrder: Number(row.sort_order ?? 0),
    count,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function mapTabItem(row: Row): TabItem {
  return {
    id: row.id as string,
    groupId: row.group_id as string,
    bookmarkId: row.bookmark_id as string,
    position: Number(row.position ?? 0),
    bookmark: {
      id: row.bookmark_id as string,
      url: row.url as string,
      title: (row.title as string) ?? '',
      faviconUrl: (row.favicon_url as string | null) ?? null,
    },
    createdAt: row.created_at as string,
  };
}

/* ------------------------------------------------------------------ *
 * Input validation (pure)
 * ------------------------------------------------------------------ */

const NAME_MIN = 1;
const NAME_MAX = 60;

export function validateGroupName(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('分组名称不能为空');
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN) throw badRequest('分组名称不能为空');
  if (name.length > NAME_MAX) throw badRequest(`分组名称不能超过 ${NAME_MAX} 个字符`);
  return name;
}

export function normalizeColorIndex(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 7) return 0;
  return n;
}

/**
 * Converts an ordered id array into explicit positions.
 *
 * Mirrors the bookmark reorder scheme: weights descend by STEP so a later
 * insert can take a midpoint value without renumbering the whole group, and
 * replaying the same ids yields the same table (idempotent).
 */
export const POSITION_STEP = 1000;

export function computePositions(ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  ids.forEach((id, index) => out.set(id, (ids.length - index) * POSITION_STEP));
  return out;
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export async function listGroups(env: Env, userId: string): Promise<TabGroup[]> {
  const rows = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.color_index, g.sort_order, g.created_at, g.updated_at,
            (SELECT COUNT(*) FROM tab_items ti WHERE ti.group_id = g.id) AS count
       FROM tab_groups g
      WHERE g.user_id = ?
      ORDER BY g.sort_order ASC, g.created_at DESC`,
  )
    .bind(userId)
    .all<Row>();

  return rows.results.map((r) => mapTabGroup(r, Number(r.count ?? 0)));
}

export async function createGroup(
  env: Env,
  userId: string,
  name: string,
  colorIndex: number,
): Promise<TabGroup> {
  const id = newId();
  const ts = nowIso();
  await env.DB.prepare(
    `INSERT INTO tab_groups (id, user_id, name, color_index, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(id, userId, name, colorIndex, ts, ts)
    .run();

  return mapTabGroup(
    { id, user_id: userId, name, color_index: colorIndex, sort_order: 0, created_at: ts, updated_at: ts },
    0,
  );
}

export interface GroupWithItems {
  group: TabGroup;
  items: TabItem[];
}

export async function getGroupWithItems(
  env: Env,
  userId: string,
  groupId: string,
): Promise<GroupWithItems | null> {
  const group = await env.DB.prepare(
    `SELECT id, user_id, name, color_index, sort_order, created_at, updated_at
       FROM tab_groups WHERE id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(groupId, userId)
    .first<Row>();
  if (!group) return null;

  const itemRows = await env.DB.prepare(
    `SELECT ti.id, ti.group_id, ti.bookmark_id, ti.position, ti.created_at,
            b.url, b.title, b.favicon_url
       FROM tab_items ti
       JOIN bookmarks b ON b.id = ti.bookmark_id
      WHERE ti.group_id = ? AND ti.user_id = ?
      ORDER BY ti.position DESC, ti.created_at ASC`,
  )
    .bind(groupId, userId)
    .all<Row>();

  return {
    group: mapTabGroup(group),
    items: itemRows.results.map(mapTabItem),
  };
}

export async function renameGroup(
  env: Env,
  userId: string,
  groupId: string,
  patch: { name?: string; colorIndex?: number },
): Promise<TabGroup | null> {
  const current = await env.DB.prepare(
    `SELECT id FROM tab_groups WHERE id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(groupId, userId)
    .first<{ id: string }>();
  if (!current) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.colorIndex !== undefined) {
    sets.push('color_index = ?');
    params.push(patch.colorIndex);
  }
  if (sets.length === 0) {
    // Nothing to change; return the existing row so the caller can respond.
    const row = await env.DB.prepare(
      `SELECT id, user_id, name, color_index, sort_order, created_at, updated_at
         FROM tab_groups WHERE id = ? AND user_id = ? LIMIT 1`,
    )
      .bind(groupId, userId)
      .first<Row>();
    return row ? mapTabGroup(row) : null;
  }

  const ts = nowIso();
  sets.push('updated_at = ?');
  params.push(ts, groupId, userId);

  await env.DB.prepare(`UPDATE tab_groups SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
    .bind(...params)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, user_id, name, color_index, sort_order, created_at, updated_at
       FROM tab_groups WHERE id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(groupId, userId)
    .first<Row>();
  return row ? mapTabGroup(row) : null;
}

export async function deleteGroup(env: Env, userId: string, groupId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM tab_groups WHERE id = ? AND user_id = ?`,
  )
    .bind(groupId, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function addItem(
  env: Env,
  userId: string,
  groupId: string,
  bookmarkId: string,
): Promise<TabItem | null> {
  // Both ownership checks in one shot: the group must belong to the user and
  // the bookmark must too. Skipping either would let a caller attach someone
  // else's bookmark to their own group, or to a group they don't own.
  const ok = await env.DB.prepare(
    `SELECT 1 FROM tab_groups g
      JOIN bookmarks b ON b.id = ?
     WHERE g.id = ? AND g.user_id = ? AND b.user_id = ? AND b.deleted_at IS NULL
     LIMIT 1`,
  )
    .bind(bookmarkId, groupId, userId, userId)
    .first();
  if (!ok) return null;

  const id = newId();
  const ts = nowIso();
  // Highest available position so a newly added tab lands at the bottom.
  const tail = await env.DB.prepare(
    `SELECT COALESCE(MIN(position), 0) AS min_pos FROM tab_items WHERE group_id = ?`,
  )
    .bind(groupId)
    .first<{ min_pos: number }>();
  const position = (tail?.min_pos ?? 0) - POSITION_STEP;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO tab_items (id, user_id, group_id, bookmark_id, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, groupId, bookmarkId, position, ts)
    .run();

  const row = await env.DB.prepare(
    `SELECT ti.id, ti.group_id, ti.bookmark_id, ti.position, ti.created_at,
            b.url, b.title, b.favicon_url
       FROM tab_items ti
       JOIN bookmarks b ON b.id = ti.bookmark_id
      WHERE ti.id = ? AND ti.user_id = ?
      LIMIT 1`,
  )
    .bind(id, userId)
    .first<Row>();
  return row ? mapTabItem(row) : null;
}

export async function removeItem(
  env: Env,
  userId: string,
  groupId: string,
  itemId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM tab_items WHERE id = ? AND group_id = ? AND user_id = ?`,
  )
    .bind(itemId, groupId, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function reorderItems(
  env: Env,
  userId: string,
  groupId: string,
  ids: string[],
): Promise<number> {
  // Confirm the group belongs to the user before touching any rows.
  const group = await env.DB.prepare(
    `SELECT id FROM tab_groups WHERE id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(groupId, userId)
    .first<{ id: string }>();
  if (!group) throw badRequest('分组不存在或不属于当前账号');

  if (ids.length === 0) return 0;

  // Reordering only the visible window is fine, but every id named must be a
  // real item in THIS group — otherwise a caller could renumber rows they
  // don't own (the UPDATE is scoped by user_id, but failing loudly is safer).
  // The IN-list is chunked to stay within D1's 100 bound-param statement cap.
  const owned: string[] = [];
  const CHUNK = 97; // 2 lead params (group_id, user_id) + ids <= 100
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const res = await env.DB.prepare(
      `SELECT id FROM tab_items WHERE group_id = ? AND user_id = ? AND id IN (${slice
        .map(() => '?')
        .join(',')})`,
    )
      .bind(groupId, userId, ...slice)
      .all<{ id: string }>();
    for (const r of res.results) owned.push(r.id);
  }

  const ownedSet = new Set(owned);
  const unknown = ids.filter((id) => !ownedSet.has(id));
  if (unknown.length > 0) {
    throw badRequest(`有 ${unknown.length} 个条目不存在或不属于该分组`);
  }

  const positions = computePositions(ids);
  // One UPDATE per row; a single batch() is capped at 100 statements, so flush
  // in groups of 90 to survive a large (up to MAX_ITEMS=500) reorder.
  const updates = [...positions.entries()].map(([id, position]) =>
    env.DB.prepare(
      `UPDATE tab_items SET position = ? WHERE id = ? AND group_id = ? AND user_id = ?`,
    ).bind(position, id, groupId, userId),
  );
  const BATCH_LIMIT = 90;
  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    await env.DB.batch(updates.slice(i, i + BATCH_LIMIT));
  }
  return ids.length;
}

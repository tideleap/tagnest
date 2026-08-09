import type { AutoGroupResult, Tag } from '../../../shared/types';
import { colorForName, mapTag } from '../db';
import { newId, nowIso } from '../ids';
import { normalizeKey } from './taxonomy';
import { computeTagHierarchy } from './grouping';

/**
 * Applies the automatic three-level hierarchy to the user's tags.
 *
 * Reads the current flat tag list, scores every tag into a
 * 一级分类 → 二级子分类 → 三级标签 tree, creates any missing category tags,
 * then rewrites each tag's `parent_id`. Returns the new flattened tree.
 *
 * Conservative: unclassified or already-deep tags are left untouched; parent
 * id rewrites are reversible via the tag PATCH endpoint.
 */
export async function applyTagHierarchy(db: D1Database, userId: string): Promise<AutoGroupResult> {
  const rows = await db
    .prepare(
      `SELECT t.id, t.name, t.color_index, t.parent_id, t.sort_order, t.created_at,
              COUNT(b.id) AS count
         FROM tags t
         LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
         LEFT JOIN bookmarks b ON b.id = bt.bookmark_id AND b.deleted_at IS NULL
        WHERE t.user_id = ?
        GROUP BY t.id`,
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  const currentTags = rows.results.map(mapTag);
  const idByName = buildNameIndex(currentTags);
  const result = computeTagHierarchy(
    currentTags.map((t) => ({ id: t.id, name: t.name, count: t.count, parentId: t.parentId })),
  );

  const toInsert: Array<{ name: string; parentId: string | null }> = [];

  const ensureTag = (originalName: string, parentId: string | null): string => {
    const key = normalizeKey(originalName);
    const existing = idByName.get(key);
    if (existing) return existing;
    const id = newId();
    idByName.set(key, id);
    toInsert.push({ name: originalName, parentId });
    return id;
  };

  // 1a) top-level categories (parent null).
  const categoryId = new Map<string, string>();
  for (const name of result.categories) categoryId.set(name, ensureTag(name, null));

  // 1b) subcategories (parent = its category's id).
  const keyForSub = (category: string, sub: string) => `${category}\u0000${sub}`;
  const subId = new Map<string, string>();
  for (const { category, sub } of result.subcategories) {
    const catId = categoryId.get(category);
    if (!catId) continue;
    subId.set(keyForSub(category, sub), ensureTag(sub, catId));
  }

  // 2) Persist newly-created category tags.
  if (toInsert.length > 0) {
    const ts = nowIso();
    const stmts = toInsert.map(({ name, parentId }) =>
      db
        .prepare(
          `INSERT INTO tags (id, user_id, name, color_index, parent_id, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .bind(idByName.get(normalizeKey(name)), userId, name, colorForName(name), parentId, ts),
    );
    for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  }

  // 3) Assign each original tag its parent id.
  const byId = new Map(currentTags.map((t) => [t.id, t]));
  const updates: D1PreparedStatement[] = [];
  for (const a of result.assignments) {
    const tag = byId.get(a.tagId);
    if (!tag) continue;
    const parentId = a.subcategory
      ? (subId.get(keyForSub(a.category, a.subcategory)) ?? null)
      : (categoryId.get(a.category) ?? null);
    if (tag.parentId === parentId) continue;
    updates.push(
      db.prepare(`UPDATE tags SET parent_id = ? WHERE id = ? AND user_id = ?`).bind(parentId, a.tagId, userId),
    );
  }
  for (let i = 0; i < updates.length; i += 90) await db.batch(updates.slice(i, i + 90));

  // 4) Read back the full (now hierarchical) tree.
  const finalRows = await db
    .prepare(
      `SELECT t.id, t.name, t.color_index, t.parent_id, t.sort_order, t.created_at,
              COUNT(b.id) AS count
         FROM tags t
         LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
         LEFT JOIN bookmarks b ON b.id = bt.bookmark_id AND b.deleted_at IS NULL
        WHERE t.user_id = ?
        GROUP BY t.id
        ORDER BY t.sort_order, t.name COLLATE NOCASE`,
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  return {
    createdCategories: toInsert.length,
    relocated: updates.length,
    untouched: result.untouchedCount,
    summary: result.summary,
    tags: finalRows.results.map(mapTag),
  };
}

/** normalized name -> id for reuse lookup. */
function buildNameIndex(tags: Tag[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const t of tags) index.set(normalizeKey(t.name), t.id);
  return index;
}

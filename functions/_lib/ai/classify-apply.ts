import type { Env } from '../env';
import { colorForName } from '../db';
import { newId, nowIso } from '../ids';
import { normalizeKey } from './taxonomy';
import {
  classifyBatch,
  DEFAULT_CLASSIFY_OPTIONS,
  type BatchClassifyResult,
  type BookmarkClassInput,
  type ClassifyOptions,
} from './classifier';
import type { ClassifyScope } from '../../../shared/types';

/**
 * Bookmark three-level classification — the data/apply layer.
 *
 * Three modes, all built on the deterministic {@link classifyBatch}:
 *
 *  - **report** (default): classify a scope and return the structured result.
 *    Pure read — no writes, safe to run any time. This is the "确保批量书签
 *    处理时分类结果稳定可靠" surface: rerunning it on an unchanged library
 *    reproduces identical predictions.
 *  - **apply**: persist the hierarchy by linking each auto-filed bookmark to its
 *    一级 and 二级 tags (created on demand, reused by normalised name). Idempotent
 *    via `INSERT OR IGNORE` on the `(bookmark_id, tag_id)` primary key. Quarantined
 *    and below-threshold items are never linked.
 *  - **revert**: the inverse of apply. Because classification is deterministic,
 *    re-classifying the same scope yields the same (category, subcategory) pairs,
 *    so we can delete exactly the links apply would have created. This makes the
 *    operation reversible without storing a manifest.
 *
 * Content-safety: quarantined bookmarks are excluded from every mode's writes.
 */

/** Max rows per D1 `batch()` call (matches the rest of the codebase). */
const BATCH_LIMIT = 90;

interface LoadedBookmark extends BookmarkClassInput {
  tags: string[];
}

/** Resolves a scope into an ordered list of bookmark ids. */
export async function resolveScopeIds(env: Env, userId: string, scope: ClassifyScope): Promise<string[]> {
  if (scope.type === 'ids') {
    const ids = (scope.ids ?? []).filter(Boolean);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id FROM bookmarks
        WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
        ORDER BY created_at DESC`,
    )
      .bind(userId, ...ids)
      .all<{ id: string }>();
    return rows.results.map((r) => String(r.id));
  }

  const untaggedClause =
    scope.type === 'untagged'
      ? `AND NOT EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id)`
      : '';

  const rows = await env.DB.prepare(
    `SELECT b.id AS id FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL ${untaggedClause}
      ORDER BY b.created_at DESC`,
  )
    .bind(userId)
    .all<{ id: string }>();
  return rows.results.map((r) => String(r.id));
}

/** Loads bookmarks (with their tag names) for the given ids, preserving order. */
async function loadBookmarks(env: Env, userId: string, ids: string[]): Promise<LoadedBookmark[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT b.id AS id, b.title AS title, b.url AS url, b.description AS description,
            t.name AS tag_name
       FROM bookmarks b
       LEFT JOIN bookmark_tags bt ON bt.bookmark_id = b.id
       LEFT JOIN tags t ON t.id = bt.tag_id AND t.user_id = ?
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND b.id IN (${placeholders})`,
  )
    .bind(userId, userId, ...ids)
    .all<Record<string, unknown>>();

  const byId = new Map<string, LoadedBookmark>();
  for (const id of ids) byId.set(id, { id, title: '', url: '', description: null, tags: [] });
  for (const row of rows.results) {
    const id = String(row.id);
    const entry = byId.get(id);
    if (!entry) continue;
    entry.title = String(row.title ?? '');
    entry.url = String(row.url ?? '');
    entry.description = (row.description as string | null) ?? null;
    const tagName = row.tag_name as string | null;
    if (tagName && !entry.tags.includes(tagName)) entry.tags.push(tagName);
  }
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

/** Existing tags as normalised-name → id (top-level categories and all tags). */
function buildTagIndexes(tags: Array<{ id: string; name: string; parentId: string | null }>) {
  const byName = new Map<string, string>();
  for (const t of tags) {
    const key = normalizeKey(t.name);
    if (!byName.has(key)) byName.set(key, t.id);
  }
  const catNameToId = new Map<string, string>();
  for (const t of tags) {
    if (t.parentId === null) catNameToId.set(normalizeKey(t.name), t.id);
  }
  return { byName, catNameToId };
}

/**
 * Reads the entire tag set; used to reuse existing category/subcategory tags
 * rather than duplicating them on every apply.
 */
async function loadAllTags(
  env: Env,
  userId: string,
): Promise<Array<{ id: string; name: string; parentId: string | null }>> {
  const rows = await env.DB.prepare(
    `SELECT id, name, parent_id FROM tags WHERE user_id = ?`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();
  return rows.results.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    parentId: (r.parent_id as string | null) ?? null,
  }));
}

/** Report mode — classify a scope, no writes. */
export async function classifyReport(
  env: Env,
  userId: string,
  scope: ClassifyScope,
  options?: Partial<ClassifyOptions>,
): Promise<BatchClassifyResult> {
  const ids = await resolveScopeIds(env, userId, scope);
  const bookmarks = await loadBookmarks(env, userId, ids);
  return classifyBatch(bookmarks, options);
}

/**
 * Apply mode — link auto-filed bookmarks to their 一级/二级 tags.
 * Idempotent; returns the number of new links created.
 */
export async function classifyApply(
  env: Env,
  userId: string,
  scope: ClassifyScope,
  options?: Partial<ClassifyOptions>,
): Promise<{ result: BatchClassifyResult; linksCreated: number }> {
  const opts = { ...DEFAULT_CLASSIFY_OPTIONS, ...options };
  const ids = await resolveScopeIds(env, userId, scope);
  const bookmarks = await loadBookmarks(env, userId, ids);
  const result = classifyBatch(bookmarks, opts);

  const tags = await loadAllTags(env, userId);
  const { byName, catNameToId } = buildTagIndexes(tags);

  // Resolve every (bookmark → category/subcategory tag) link apply will create,
  // minting ids for any missing category/subcategory tags as we go.
  const created = new Map<string, { id: string; name: string; parentId: string | null }>();
  const ensureExplicit = (name: string, parentId: string | null): string => {
    const key = normalizeKey(name);
    const existing = parentId === null ? catNameToId.get(key) : byName.get(key);
    if (existing) return existing;
    const id = newId();
    if (parentId === null) catNameToId.set(key, id);
    else byName.set(key, id);
    created.set(id, { id, name, parentId });
    return id;
  };

  const pairsFinal: Array<{ bookmarkId: string; tagId: string }> = [];
  const seenFinal = new Set<string>();
  for (const p of result.predictions) {
    if (p.quarantined || p.needsReview || !p.category || !p.subcategory) continue;
    const catId = ensureExplicit(p.category, null);
    const subId = ensureExplicit(p.subcategory, catId);
    for (const tagId of [catId, subId]) {
      const k = `${p.bookmarkId}\u0000${tagId}`;
      if (!seenFinal.has(k)) {
        seenFinal.add(k);
        pairsFinal.push({ bookmarkId: p.bookmarkId, tagId });
      }
    }
  }

  // 1) create any missing category / subcategory tags
  if (created.size > 0) {
    const ts = nowIso();
    const inserts = [...created.values()].map((c) =>
      env.DB.prepare(
        `INSERT INTO tags (id, user_id, name, color_index, parent_id, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).bind(c.id, userId, c.name, colorForName(c.name), c.parentId, ts),
    );
    for (let i = 0; i < inserts.length; i += BATCH_LIMIT) {
      await env.DB.batch(inserts.slice(i, i + BATCH_LIMIT));
    }
  }

  // 2) link bookmarks to hierarchy tags (idempotent via primary key)
  let linksCreated = 0;
  if (pairsFinal.length > 0) {
    const linkStmts = pairsFinal.map(({ bookmarkId, tagId }) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)`,
      ).bind(bookmarkId, tagId),
    );
    for (let i = 0; i < linkStmts.length; i += BATCH_LIMIT) {
      const res = await env.DB.batch(linkStmts.slice(i, i + BATCH_LIMIT));
      for (const r of res) linksCreated += Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0);
    }
  }

  return { result, linksCreated };
}

/**
 * Revert mode — remove the hierarchy links apply created. Deterministic
 * re-classification reproduces the same (category, subcategory) pairs, so we
 * delete those exact (bookmark, tag) links. No manifest needed.
 */
export async function classifyRevert(
  env: Env,
  userId: string,
  scope: ClassifyScope,
  options?: Partial<ClassifyOptions>,
): Promise<{ result: BatchClassifyResult; linksRemoved: number }> {
  const opts = { ...DEFAULT_CLASSIFY_OPTIONS, ...options };
  const ids = await resolveScopeIds(env, userId, scope);
  const bookmarks = await loadBookmarks(env, userId, ids);
  const result = classifyBatch(bookmarks, opts);

  const tags = await loadAllTags(env, userId);
  const { catNameToId } = buildTagIndexes(tags);

  const tagIdsToRemove = new Set<string>();
  for (const p of result.predictions) {
    if (p.quarantined || p.needsReview || !p.category || !p.subcategory) continue;
    const catId = catNameToId.get(normalizeKey(p.category));
    if (catId) tagIdsToRemove.add(catId);
    // find subcategory tag whose parent is catId and name matches
    for (const t of tags) {
      if (t.parentId === catId && normalizeKey(t.name) === normalizeKey(p.subcategory)) {
        tagIdsToRemove.add(t.id);
        break;
      }
    }
  }

  let linksRemoved = 0;
  if (tagIdsToRemove.size > 0 && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const tagPlaceholders = [...tagIdsToRemove].map(() => '?').join(',');
    const res = await env.DB.prepare(
      `DELETE FROM bookmark_tags
        WHERE bookmark_id IN (${placeholders}) AND tag_id IN (${tagPlaceholders})`,
    )
      .bind(...ids, ...tagIdsToRemove)
      .run();
    linksRemoved = Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0);
  }

  return { result, linksRemoved };
}

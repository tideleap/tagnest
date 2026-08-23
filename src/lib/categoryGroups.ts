import type { Bookmark, Tag } from '@shared/types';

/**
 * Client-side two-level category grouping for the Library's "分类" view.
 *
 * Mirrors the share page's directory semantics (see
 * `functions/_lib/shares.ts#buildDirectoryGroups`) with one deliberate
 * upgrade: tags are resolved through the FULL tag graph, so a bookmark
 * carrying only a deep tag (child or grandchild) is still bucketed under its
 * top-level ancestor instead of being silently dropped.
 *
 * Level 1 = top-level tags; level 2 = child-tag sub-buckets first, then the
 * group's direct bookmarks. A bookmark carrying several top-level tags is
 * listed under each of them (same as the directory theme); within one group a
 * bookmark that matches both the group tag and a child tag lands in the child
 * bucket only, and multiple child matches resolve to the alphabetically first
 * child so an item never double-lists inside a group.
 */

export const UNTAGGED_GROUP_ID = '__untagged';

export interface CategoryChildGroup {
  id: string;
  name: string;
  colorIndex: number;
  items: Bookmark[];
}

export interface CategoryGroup {
  /** Tag id, or `UNTAGGED_GROUP_ID` for the catch-all. */
  id: string;
  name: string;
  colorIndex: number;
  /** Bookmarks carrying the group tag but none of its child tags. */
  directItems: Bookmark[];
  /** Non-empty child-tag sub-buckets, sorted by name. */
  children: CategoryChildGroup[];
}

export function buildCategoryGroups(tags: Tag[], bookmarks: Bookmark[]): CategoryGroup[] {
  if (bookmarks.length === 0) return [];

  // Merged tag graph: bookmark-embedded tag objects first (they travel with
  // the row even if the tag list cache is stale), fresh tag list wins on id.
  const tagById = new Map<string, Tag>();
  for (const b of bookmarks) for (const t of b.tags) tagById.set(t.id, t);
  for (const t of tags) tagById.set(t.id, t);

  /** Walks `parentId` up to the top-level ancestor (cycle-safe). */
  const rootOf = (start: Tag): Tag => {
    let cur = start;
    const seen = new Set<string>();
    while (cur.parentId && tagById.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = tagById.get(cur.parentId)!;
    }
    return cur;
  };

  /** The depth-1 ancestor of `t` under `root` (call with t.id !== root.id). */
  const childUnder = (t: Tag, root: Tag): Tag => {
    let cur = t;
    const seen = new Set<string>();
    while (cur.parentId && cur.parentId !== root.id && tagById.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = tagById.get(cur.parentId)!;
    }
    return cur;
  };

  interface Placement {
    bookmark: Bookmark;
    /** Level-2 bucket tag id; null = direct item of the group. */
    childId: string | null;
  }

  const byRoot = new Map<string, { root: Tag; placements: Placement[] }>();
  const untagged: Bookmark[] = [];

  for (const b of bookmarks) {
    if (b.tags.length === 0) {
      untagged.push(b);
      continue;
    }

    // Resolve this bookmark's tags per root group so one item can surface
    // under several top-level categories without duplicating inside one.
    const perRoot = new Map<string, { root: Tag; childIds: string[] }>();
    for (const t of b.tags) {
      const self = tagById.get(t.id) ?? t;
      const root = rootOf(self);
      let entry = perRoot.get(root.id);
      if (!entry) {
        entry = { root, childIds: [] };
        perRoot.set(root.id, entry);
      }
      if (self.id !== root.id) entry.childIds.push(childUnder(self, root).id);
    }

    for (const { root, childIds } of perRoot.values()) {
      let g = byRoot.get(root.id);
      if (!g) {
        g = { root, placements: [] };
        byRoot.set(root.id, g);
      }
      if (childIds.length > 0) {
        // Deterministic single bucket: alphabetically first child name.
        const first = [...new Set(childIds)]
          .map((id) => tagById.get(id)!)
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))[0];
        g.placements.push({ bookmark: b, childId: first.id });
      } else {
        g.placements.push({ bookmark: b, childId: null });
      }
    }
  }

  const groups: CategoryGroup[] = [];
  for (const { root, placements } of byRoot.values()) {
    const directItems = placements.filter((p) => p.childId === null).map((p) => p.bookmark);
    const childBuckets = new Map<string, Bookmark[]>();
    for (const p of placements) {
      if (!p.childId) continue;
      const list = childBuckets.get(p.childId) ?? [];
      list.push(p.bookmark);
      childBuckets.set(p.childId, list);
    }
    const children: CategoryChildGroup[] = [...childBuckets.entries()]
      .map(([id, list]) => {
        const t = tagById.get(id)!;
        return { id, name: t.name, colorIndex: t.colorIndex, items: list };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    // Empty groups are dropped: a tag with no visible bookmarks has no
    // business occupying a section in the browse view.
    if (directItems.length === 0 && children.length === 0) continue;
    groups.push({
      id: root.id,
      name: root.name,
      colorIndex: root.colorIndex,
      directItems,
      children,
    });
  }

  groups.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  if (untagged.length > 0) {
    groups.push({
      id: UNTAGGED_GROUP_ID,
      name: '未分类',
      colorIndex: 0,
      directItems: untagged,
      children: [],
    });
  }

  return groups;
}

/* ------------------------------------------------------------------ *
 * CategorySync (C2-1): primary-category single-placement grouping
 * ------------------------------------------------------------------ */

/**
 * CategorySync C2-1 — groups bookmarks by their PRIMARY category.
 *
 * The legacy `buildCategoryGroups` above is multi-tag / multi-placement: one
 * bookmark surfaces under every top-level tag it carries. The category view
 * required by CategorySync is the opposite — every bookmark has exactly ONE
 * primary category (`bookmark_primary_category`), so it must appear exactly
 * once. This function renders that contract:
 *
 *  - A bookmark whose `primaryCategoryByBookmark` entry carries a path is
 *    bucketed under that path — level 1 = path[0], level 2 = path[1] when
 *    present (deeper paths fold into the level-2 bucket; the view is
 *    two-level).
 *  - A bookmark with no placement (absent / null / empty path) lands in the
 *    `__untagged` catch-all, which doubles as the C2-5 "未分类" entry point.
 *
 * Paths are resolved against the tag graph BY NAME (the writeback feed only
 * carries names, never ids — the path is derived server-side by walking
 * `parent_id`). When a path's top-level name no longer exists in the tag
 * tree (tag deleted out from under a placement), the bookmark is kept in a
 * synthetic group named after the path instead of being dropped — losing
 * items from the view would read as data loss.
 */
export function buildPrimaryCategoryGroups(
  tags: Tag[],
  bookmarks: Bookmark[],
  /** bookmarkId → primary category path (tag names); absent/null = 未分类. */
  primaryCategoryByBookmark: ReadonlyMap<string, readonly string[] | null>,
): CategoryGroup[] {
  if (bookmarks.length === 0) return [];

  // Name indexes over the merged tag graph (bookmark-embedded tags first,
  // fresh tag list wins — same merge rule as the legacy grouping).
  const tagById = new Map<string, Tag>();
  for (const b of bookmarks) for (const t of b.tags) tagById.set(t.id, t);
  for (const t of tags) tagById.set(t.id, t);

  const topLevelByName = new Map<string, Tag>();
  const childByName = new Map<string, Map<string, Tag>>();
  for (const t of tagById.values()) {
    if (!t.parentId) {
      if (!topLevelByName.has(t.name)) topLevelByName.set(t.name, t);
      continue;
    }
    let siblings = childByName.get(t.parentId);
    if (!siblings) {
      siblings = new Map();
      childByName.set(t.parentId, siblings);
    }
    if (!siblings.has(t.name)) siblings.set(t.name, t);
  }

  interface Placement {
    bookmark: Bookmark;
    /** Level-2 bucket tag id; null = direct item of the group. */
    childId: string | null;
  }

  const byRoot = new Map<string, { root: Tag; placements: Placement[] }>();
  /** Bookmarks whose path root no longer exists in the tag tree. */
  const detached = new Map<string, { pathLabel: string; items: Bookmark[] }>();
  const untagged: Bookmark[] = [];

  for (const b of bookmarks) {
    const path = primaryCategoryByBookmark.get(b.id);
    if (!path || path.length === 0) {
      untagged.push(b);
      continue;
    }

    const root = topLevelByName.get(path[0]);
    if (!root) {
      const pathLabel = path.join(' > ');
      const held = detached.get(pathLabel);
      if (held) held.items.push(b);
      else detached.set(pathLabel, { pathLabel, items: [b] });
      continue;
    }

    let g = byRoot.get(root.id);
    if (!g) {
      g = { root, placements: [] };
      byRoot.set(root.id, g);
    }

    // Level-2 bucket when the path names an existing child of the root;
    // otherwise the bookmark stays directly under the level-1 category.
    const child = path.length > 1 ? childByName.get(root.id)?.get(path[1]) : undefined;
    g.placements.push({ bookmark: b, childId: child ? child.id : null });
  }

  const groups: CategoryGroup[] = [];

  for (const { root, placements } of byRoot.values()) {
    const directItems = placements.filter((p) => p.childId === null).map((p) => p.bookmark);
    const childBuckets = new Map<string, Bookmark[]>();
    for (const p of placements) {
      if (!p.childId) continue;
      const list = childBuckets.get(p.childId) ?? [];
      list.push(p.bookmark);
      childBuckets.set(p.childId, list);
    }
    const children: CategoryChildGroup[] = [...childBuckets.entries()]
      .map(([id, list]) => {
        const t = tagById.get(id)!;
        return { id, name: t.name, colorIndex: t.colorIndex, items: list };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    if (directItems.length === 0 && children.length === 0) continue;
    groups.push({
      id: root.id,
      name: root.name,
      colorIndex: root.colorIndex,
      directItems,
      children,
    });
  }

  // Synthetic groups for paths whose root tag is gone. Stable id derived from
  // the path so collapse state and React keys stay consistent.
  for (const { pathLabel, items } of detached.values()) {
    groups.push({
      id: `__path:${pathLabel}`,
      name: pathLabel,
      colorIndex: 0,
      directItems: items,
      children: [],
    });
  }

  groups.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  if (untagged.length > 0) {
    groups.push({
      id: UNTAGGED_GROUP_ID,
      name: '未分类',
      colorIndex: 0,
      directItems: untagged,
      children: [],
    });
  }

  return groups;
}

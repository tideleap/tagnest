import type { Tag } from '@shared/types';

/**
 * A tag with its resolved subtree attached.
 *
 * Tags form a forest keyed by `parentId`. `buildTagTree` turns the flat list
 * into one tree per top-level tag so the UI can render groups → subgroups
 * without re-deriving the hierarchy on every render.
 */
export interface TreeNode extends Tag {
  children: TreeNode[];
}

export type TagSortKey = 'count' | 'name' | 'recent';

/**
 * Builds the tag forest from a flat list.
 *
 * Pure and stable: every node keeps its `Tag` shape (so callers can pass a
 * `TreeNode` wherever they expect a `Tag`), children are attached by `parentId`,
 * and each level is sorted by `sortKey`. Used by both the sidebar nav tree and
 * the full Tags page so the grouping logic lives in exactly one place.
 */
export function buildTagTree(tags: Tag[], sortKey: TagSortKey = 'count'): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const t of tags) nodes.set(t.id, { ...t, children: [] });

  const tops: TreeNode[] = [];
  for (const t of tags) {
    const node = nodes.get(t.id)!;
    if (t.parentId && nodes.has(t.parentId)) nodes.get(t.parentId)!.children.push(node);
    else tops.push(node);
  }

  const sort = (a: TreeNode, b: TreeNode) => {
    if (sortKey === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (sortKey === 'recent') return b.createdAt.localeCompare(a.createdAt);
    return b.count - a.count || a.name.localeCompare(b.name, 'zh-CN');
  };

  for (const node of nodes.values()) node.children.sort(sort);
  return tops.sort(sort);
}

/**
 * Prunes a tag tree to only the nodes whose name matches `query`, keeping a
 * node whenever it matches itself OR has a descendant that matches. Returns the
 * tree unchanged when the query is empty. Used by the Tags page search box so a
 * group stays visible as long as it (or any of its bookmarks' tags) matches.
 */
export function filterTagTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  const prune = (node: TreeNode): TreeNode | null => {
    const selfMatches = node.name.toLowerCase().includes(q);
    const keptChildren = node.children.map(prune).filter((c): c is TreeNode => c !== null);
    if (selfMatches || keptChildren.length > 0) {
      return { ...node, children: selfMatches ? node.children : keptChildren };
    }
    return null;
  };

  return nodes.map(prune).filter((c): c is TreeNode => c !== null);
}

/**
 * Collects a tag id plus every descendant id in its subtree.
 *
 * Powers "include subtags" filtering: clicking a parent tag in the sidebar or
 * on the Tags page should surface every bookmark tagged with that tag OR any of
 * its children. The result is fed straight into the existing multi-tag
 * `?tagIds` (OR) filter, so no backend change is needed. Pure and deterministic.
 */
export function subtreeIds(tags: Tag[], rootId: string): string[] {
  const childrenOf = new Map<string | null, string[]>();
  for (const t of tags) {
    const key = t.parentId ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(t.id);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return out;
}

/**
 * Builds the option list for a "parent tag" picker.
 *
 * Every tag except `excludeId` and its descendants is offered (a tag can never
 * be its own ancestor). Labels are indented to mirror the tree so the hierarchy
 * reads clearly in a flat dropdown. The (top-level) option carries an empty
 * value, which the API maps to `parent_id = NULL`.
 */
export interface ParentOption {
  value: string;
  label: string;
}

export function candidateParents(tags: Tag[], excludeId?: string | null): ParentOption[] {
  const excluded = excludeId ? new Set(subtreeIds(tags, excludeId)) : new Set<string>();

  // Depth of each tag = number of ancestors, used purely for label indentation.
  const depthOf = new Map<string, number>();
  const resolve = (t: Tag, depth: number): number => {
    if (depthOf.has(t.id)) return depthOf.get(t.id)!;
    const d = t.parentId && depthOf.has(t.parentId) ? depthOf.get(t.parentId)! + 1 : depth;
    depthOf.set(t.id, d);
    return d;
  };
  for (const t of tags) resolve(t, 0);

  const ordered = tags
    .filter((t) => !excluded.has(t.id))
    .slice()
    .sort((a, b) => (depthOf.get(a.id) ?? 0) - (depthOf.get(b.id) ?? 0) || a.name.localeCompare(b.name, 'zh-CN'));

  return ordered.map((t) => ({
    value: t.id,
    label: (depthOf.get(t.id) ?? 0) > 0 ? `${' '.repeat(depthOf.get(t.id)!)}↳ ${t.name}` : t.name,
  }));
}

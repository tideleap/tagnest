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

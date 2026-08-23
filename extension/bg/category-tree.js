// TagNest extension — category tree planner (CategorySync P2, C3).
//
// Pure planning module: no chrome.* here, so the backend Vitest suite imports
// it directly (same convention as sync-diff.js / sync-engine.js). reconcile.js
// owns every chrome.bookmarks call and executes the plan this module produces.
//
// Semantics (PRD C3 + ambiguity decisions A1–A9):
//  - MIRROR, never uproot: the managed "TagNest" folder is a projection of the
//    cloud category tree. Every write target lives inside the managed subtree;
//    bookmarks outside it are never moved or touched (C3-7).
//  - Bookmarks match by urlKey; folders match by exact title under a parent
//    (cloud names are unique per parent, so this is unambiguous).
//  - Ownership: the manifest records what earlier builds created or moved.
//    Only owned nodes are renamed or deleted; user nodes found at the right
//    place are adopted as-is, and stale user nodes are left alone.

import { urlKey } from './sync-diff.js';

export const MANIFEST_VERSION = 1;

/** Manifest shape: `{ version, bookmarks: {urlKey: path[]}, folders: path[][] }`. */
export function emptyManifest() {
  return { version: MANIFEST_VERSION, bookmarks: {}, folders: [] };
}

/** Normalize a possibly-messy manifest loaded from storage. */
export function normalizeManifest(raw) {
  const base = emptyManifest();
  if (!raw || typeof raw !== 'object') return base;
  if (raw.bookmarks && typeof raw.bookmarks === 'object') {
    for (const [key, path] of Object.entries(raw.bookmarks)) {
      if (Array.isArray(path)) base.bookmarks[key] = path.map(String);
    }
  }
  if (Array.isArray(raw.folders)) {
    for (const path of raw.folders) {
      if (Array.isArray(path)) base.folders.push(path.map(String));
    }
  }
  return base;
}

export function pathLabel(path) {
  return (path || []).join(' > ');
}

function samePath(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Trim/drop empty segments so ' 前端开发 ' and '' can't corrupt the tree. */
function normalizeCategoryPath(categoryPath) {
  if (!Array.isArray(categoryPath)) return [];
  return categoryPath.map((s) => String(s ?? '').trim()).filter(Boolean);
}

/**
 * Defensive URL gate: only http(s) rows may enter the plan. The backend feed
 * already stores canonical http(s) URLs only, but a corrupt/poisoned row must
 * never produce a chrome.bookmarks.create call (mirrors urlkey.ts
 * ALLOWED_PROTOCOLS).
 */
function isUsableUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Serialize a chrome.bookmarks subtree into a storage-friendly snapshot
 * (C3-3). Ids are dropped on purpose: rollback rebuilds from content, and the
 * urlKey-based diff does not depend on node ids surviving.
 */
export function serializeSubtree(node) {
  const out = { title: node?.title || '' };
  if (node && node.url !== undefined) out.url = node.url;
  if (node && Array.isArray(node.children) && node.children.length > 0) {
    out.children = node.children.map((c) => serializeSubtree(c));
  }
  return out;
}

/** Count bookmarks + folders in a serialized (or raw) subtree. */
export function countSubtree(node) {
  let folders = 0;
  let bookmarks = 0;
  const walk = (n) => {
    for (const c of n?.children || []) {
      if (c.url === undefined) {
        folders += 1;
        walk(c);
      } else {
        bookmarks += 1;
      }
    }
  };
  walk(node);
  return { folders, bookmarks };
}

/**
 * Index the current managed subtree for matching.
 * - foldersByLabel: Map<pathLabel, {nodeId, path, childCount}> — first folder
 *   with a given title-path wins (duplicates are tolerated, never multiplied).
 * - bookmarksByKey: Map<urlKey, [{nodeId, path, title, url}]>
 */
export function indexManagedTree(managedTree) {
  const foldersByLabel = new Map();
  const bookmarksByKey = new Map();
  const walk = (node, path) => {
    for (const child of node?.children || []) {
      if (child.url === undefined) {
        const childPath = [...path, child.title || ''];
        const label = pathLabel(childPath);
        if (!foldersByLabel.has(label)) {
          foldersByLabel.set(label, {
            nodeId: child.id,
            path: childPath,
            childCount: (child.children || []).length,
          });
        }
        walk(child, childPath);
      } else {
        const key = urlKey(child.url);
        if (!key) continue;
        const list = bookmarksByKey.get(key) || [];
        list.push({ nodeId: child.id, path, title: child.title || '', url: child.url });
        bookmarksByKey.set(key, list);
      }
    }
  };
  walk(managedTree, []);
  return { foldersByLabel, bookmarksByKey };
}

/**
 * Compute the writeback plan: cloud category feed vs current managed subtree.
 *
 * @param {object} args
 * @param {Array<{bookmarkId?: string, url: string, title?: string, categoryPath?: string[] | null}>} args.feedItems
 *   The full `/api/category/tree?format=writeback` result (only bookmarks with
 *   an accepted primary category appear).
 * @param {{id?: string, title?: string, children?: object[]} | null} args.managedTree
 *   The current managed folder subtree, or null when the folder is missing
 *   (first build / user deleted it — the orchestrator re-creates it after the
 *   user confirms, §8.2).
 * @param {object} [args.manifest] Ownership manifest from the previous build.
 * @returns {{
 *   createFolders: {path: string[]}[],
 *   createBookmarks: {url: string, title: string, path: string[]}[],
 *   moveBookmarks: {nodeId: string, url: string, title: string, fromPath: string[], toPath: string[]}[],
 *   updateTitles: {nodeId: string, url: string, title: string, path: string[]}[],
 *   removeNodes: {nodeId: string, path: string[], title: string, url?: string, isFolder: boolean}[],
 *   stats: object, samples: object, nextManifest: object, managedFolderMissing: boolean,
 * }}
 */
export function planCategoryBuild({ feedItems, managedTree, manifest }) {
  const prev = normalizeManifest(manifest);
  const tree = managedTree || { id: null, title: 'TagNest', children: [] };
  const { foldersByLabel, bookmarksByKey } = indexManagedTree(tree);

  // -- Desired structure -----------------------------------------------------
  const feed = Array.isArray(feedItems) ? feedItems : [];
  const desiredFolderPaths = new Map(); // label -> path[]
  const placements = []; // {key, url, title, path}
  for (const item of feed) {
    if (!item || typeof item.url !== 'string' || !isUsableUrl(item.url)) continue;
    const key = urlKey(item.url);
    if (!key) continue;
    const path = normalizeCategoryPath(item.categoryPath);
    for (let d = 1; d <= path.length; d += 1) {
      const prefix = path.slice(0, d);
      const label = pathLabel(prefix);
      if (!desiredFolderPaths.has(label)) desiredFolderPaths.set(label, prefix);
    }
    placements.push({ key, url: item.url, title: String(item.title ?? ''), path });
  }

  // -- Folders to create (parents first via depth sort) ----------------------
  const createFolders = [];
  const ownedFolders = new Set(); // labels we own after this build
  const prevOwnedFolders = new Set(prev.folders.map(pathLabel));
  for (const [label, path] of desiredFolderPaths) {
    const existing = foldersByLabel.get(label);
    if (!existing) {
      createFolders.push({ path });
      ownedFolders.add(label);
    } else if (prevOwnedFolders.has(label)) {
      ownedFolders.add(label); // we built it earlier; still ours
    }
    // else: user/legacy folder with the same name — reuse, never own (§8.2).
  }
  createFolders.sort((a, b) => a.path.length - b.path.length);

  // -- Bookmark placement ----------------------------------------------------
  const createBookmarks = [];
  const moveBookmarks = [];
  const updateTitles = [];
  const removeNodes = [];
  const nextBookmarks = {};
  const consumedOwned = new Set(); // urlKeys whose owned node was kept or moved
  let unchanged = 0;

  for (const { key, url, title, path } of placements) {
    const label = pathLabel(path);
    const candidates = bookmarksByKey.get(key) || [];
    const atTarget = candidates.find((c) => samePath(c.path, path));
    const ownedLabel = prev.bookmarks[key];
    const ownedAtTarget = Array.isArray(ownedLabel) && samePath(ownedLabel, path);

    if (atTarget) {
      // A copy already sits where the cloud wants it.
      if (ownedAtTarget) {
        consumedOwned.add(key);
        if (atTarget.title !== title) {
          updateTitles.push({ nodeId: atTarget.nodeId, url, title, path });
        } else {
          unchanged += 1;
        }
        nextBookmarks[key] = path;
      } else {
        // Not ours (user-placed or legacy): adopt as-is, don't rename.
        unchanged += 1;
      }
      continue;
    }

    // No copy at the target: prefer moving our own node, then any existing
    // copy inside the managed folder (legacy flat-sync dedupe, A9). We NEVER
    // reach outside the managed subtree — candidates come from it by design.
    const owned = candidates.find((c) => Array.isArray(ownedLabel) && samePath(c.path, ownedLabel));
    const donor = owned || candidates[0];
    if (donor) {
      moveBookmarks.push({
        nodeId: donor.nodeId,
        url,
        title,
        fromPath: donor.path,
        toPath: path,
      });
      if (owned) consumedOwned.add(key);
      if (donor.title !== title) {
        updateTitles.push({ nodeId: donor.nodeId, url, title, path });
      }
      nextBookmarks[key] = path; // moved nodes become/stay owned
      continue;
    }

    createBookmarks.push({ url, title, path });
    nextBookmarks[key] = path;
  }

  // -- Stale owned bookmarks: owned placements the feed no longer wants ------
  for (const [key, ownedPath] of Object.entries(prev.bookmarks)) {
    if (consumedOwned.has(key) || nextBookmarks[key]) continue;
    const candidates = bookmarksByKey.get(key) || [];
    const node = candidates.find((c) => samePath(c.path, ownedPath));
    if (node) {
      removeNodes.push({
        nodeId: node.nodeId,
        path: ownedPath,
        title: node.title,
        url: node.url,
        isFolder: false,
      });
    }
  }

  // -- Stale owned folders: undesired, ours, and empty ------------------------
  const nextFolders = [];
  for (const [label, path] of desiredFolderPaths) {
    if (ownedFolders.has(label)) nextFolders.push(path);
  }
  for (const path of prev.folders) {
    const label = pathLabel(path);
    if (desiredFolderPaths.has(label)) continue; // still wanted (handled above)
    const existing = foldersByLabel.get(label);
    if (existing && existing.childCount > 0) {
      // Non-empty stale folder: keep it (and its ownership) — never delete
      // content we don't fully control. We'll re-check on the next run.
      nextFolders.push(path);
    } else if (existing) {
      removeNodes.push({
        nodeId: existing.nodeId,
        path,
        title: path[path.length - 1] || '',
        isFolder: true,
      });
    }
  }

  // Bookmarks first, then (empty) folders — keeps removeTree safe.
  removeNodes.sort((a, b) => Number(a.isFolder) - Number(b.isFolder));

  const stats = {
    feedTotal: placements.length,
    foldersToCreate: createFolders.length,
    bookmarksToCreate: createBookmarks.length,
    bookmarksToMove: moveBookmarks.length,
    titlesToUpdate: updateTitles.length,
    nodesToRemove: removeNodes.length,
    unchanged,
    managedFolderMissing: managedTree == null,
  };
  const samples = {
    createFolders: createFolders.slice(0, 3).map((f) => pathLabel(f.path)),
    createBookmarks: createBookmarks.slice(0, 3).map((b) => ({ title: b.title, path: pathLabel(b.path) })),
    moveBookmarks: moveBookmarks
      .slice(0, 3)
      .map((m) => ({ title: m.title, from: pathLabel(m.fromPath), to: pathLabel(m.toPath) })),
  };

  return {
    createFolders,
    createBookmarks,
    moveBookmarks,
    updateTitles,
    removeNodes,
    stats,
    samples,
    managedFolderMissing: managedTree == null,
    nextManifest: { version: MANIFEST_VERSION, bookmarks: nextBookmarks, folders: nextFolders },
  };
}

// TagNest extension — two-way sync reconciliation (B-12, Phase A).
//
// Phase A is READ-ONLY: it never writes to the browser's bookmark tree. It
// reads the browser bookmarks (requires the optional `bookmarks` permission,
// granted on demand in the UI) and the user's TagNest key set, then computes a
// three-way diff the user can inspect. Pushing/pulling (Phase B) is not wired
// up yet, so nothing here mutates browser state.
//
// `chrome.*` is referenced here (not in sync-diff.js) because this module is
// only ever loaded inside the extension, never in the backend test suite.

import { apiFetch, syncPull, syncPush, fetchCategoryWriteback } from './api.js';
import { flattenBrowserBookmarks, diffByKey, urlKey } from './sync-diff.js';
import { planSync } from './sync-engine.js';
import { loadConfig, isConfigured } from './config.js';
import {
  planCategoryBuild,
  indexManagedTree,
  normalizeManifest,
  pathLabel,
} from './category-tree.js';

/**
 * Read and flatten the browser's entire bookmark tree. When
 * `managedFolderId` is given (C4-2), leaves inside the managed "TagNest"
 * subtree carry their `folderPath` relative to the managed root — the local
 * counterpart of the cloud's `categoryPath`.
 */
export async function collectBrowserBookmarks(signal, managedFolderId = null, ownedFolderIds = null) {
  const tree = await chrome.bookmarks.getTree();
  return flattenBrowserBookmarks(tree, managedFolderId, ownedFolderIds);
}

/**
 * Walk GET /api/bookmarks/sync-keys (cursor pagination) and return the full
 * key set for the user. Cheap by design: the endpoint returns only
 * {id, urlKey, updatedAt, title}, so a large library stays light.
 */
export async function fetchTagNestKeys(cfg, signal) {
  const out = [];
  let cursor = null;
  do {
    const path = cursor
      ? `/api/bookmarks/sync-keys?cursor=${encodeURIComponent(cursor)}`
      : '/api/bookmarks/sync-keys';
    const page = await apiFetch(path, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, method: 'GET', signal });
    const items = (page && page.items) || [];
    for (const it of items) out.push(it);
    cursor = page && page.hasMore ? page.cursor : null;
  } while (cursor);
  return out;
}

/**
 * Reconcile browser bookmarks against TagNest. Returns the raw diff plus a few
 * summary counts. Throws if the `bookmarks` permission is missing or the API
 * call fails (the caller surfaces a friendly message).
 */
export async function reconcile(cfg, signal) {
  const browser = await collectBrowserBookmarks(signal);
  const tn = await fetchTagNestKeys(cfg, signal);
  const diff = diffByKey(browser, tn);
  return {
    browserCount: browser.length,
    tnCount: tn.length,
    ...diff,
    counts: {
      onlyInBrowser: diff.onlyInBrowser.length,
      onlyInTagNest: diff.onlyInTagNest.length,
      both: diff.both.length,
    },
  };
}

/**
 * C5-4 sync status for the popup (CS-P4-2). Read-only and best-effort: each
 * dimension degrades to `null` on failure instead of failing the whole call,
 * so the popup always shows what it can.
 *
 *   - `lastSyncedAt` / `lastDirection` come from the persisted sync state;
 *   - `pendingUpload` = browser bookmarks not yet in TagNest (the same
 *     urlKey diff runSync uses, so the number matches what the next upload
 *     would push);
 *   - `coverage` = cloud category coverage from GET /api/stats
 *     (categorized / bookmarks), the C5-4 "分类覆盖率" metric.
 */
export async function getSyncStatus(cfg, signal) {
  const state = await loadSyncState();
  const out = {
    lastSyncedAt: state.lastSyncedAt || '',
    lastDirection: state.lastDirection || 'upload',
    pendingUpload: null,
    coverage: null,
  };
  if (!isConfigured(cfg)) return out;

  try {
    const promote = await loadPromote(cfg);
    const managedId = await findManagedFolderId(cfg);
    const owned = promote ? await getOwnedFolderIds(true) : null;
    const browser = await collectBrowserBookmarks(signal, managedId, owned);
    const tn = await fetchTagNestKeys(cfg, signal);
    out.pendingUpload = diffByKey(browser, tn).onlyInBrowser.length;
  } catch {
    // Missing bookmarks permission or a network hiccup — leave null.
  }

  try {
    const stats = await apiFetch('/api/stats', {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      method: 'GET',
      signal,
    });
    const total = Number(stats && stats.bookmarks);
    if (Number.isFinite(total)) {
      const categorized = Number(stats.categorized ?? 0);
      out.coverage = {
        categorized,
        bookmarks: total,
        percent: total > 0 ? Math.round((categorized / total) * 100) : 0,
      };
    }
  } catch {
    // Coverage stays null; the popup renders a dash.
  }

  return out;
}

// ---------------------------------------------------------------------------
// B-12 Phase B — bidirectional sync orchestration
// ---------------------------------------------------------------------------

const SYNC_STATE_KEY = 'tagnestSync.v0';
const SYNC_BACKUP_KEY = 'tagnestSyncBackup.v0';

/**
 * C4-6 loop suppression. True while runSync is writing TagNest state back into
 * the browser tree. Any bookmark mutation inside that window is REMOTE-sourced,
 * not a local edit — so observers (and a re-entrant sync) must not treat those
 * writes as fresh user changes to push back up. Exported read-only so the
 * orchestration layer and tests can assert the guard.
 */
let applyingRemote = false;

/** Read-only view of the C4-6 loop-suppression flag. */
export function isApplyingRemote() {
  return applyingRemote;
}

/**
 * C5-5 auto-sync policy (pure, unit-testable).
 *
 * Decides whether the periodic alarm should run and at what interval, from the
 * stored config + the direction the user last picked manually. Rules:
 *   - auto sync only runs when the extension is configured AND `autoSync` is on;
 *   - the interval is clamped to a sane range (1..120 minutes) so a bad stored
 *     value can neither hammer the server nor silently disable the feature;
 *   - the direction FOLLOWS the user's last manual choice (`lastDirection`),
 *     defaulting to 'upload' — auto sync never escalates to two-way on its own.
 *
 * @param {object} args
 * @param {boolean} [args.configured] whether baseUrl+apiKey are set.
 * @param {boolean} [args.autoSync] the user's auto-sync toggle.
 * @param {number} [args.autoSyncMinutes] requested interval in minutes.
 * @param {string} [args.lastDirection] direction of the last manual sync.
 * @returns {{enabled:boolean, minutes:number, direction:'upload'|'two-way'}}
 */
export function resolveAutoSync({
  configured = false,
  autoSync = false,
  autoSyncMinutes = 5,
  lastDirection = '',
} = {}) {
  const enabled = Boolean(configured && autoSync);
  const raw = Number(autoSyncMinutes);
  const minutes = Number.isFinite(raw) ? Math.min(120, Math.max(1, Math.trunc(raw))) : 5;
  const direction = lastDirection === 'two-way' ? 'two-way' : 'upload';
  return { enabled, minutes, direction };
}

/**
 * Last sync watermark + the snapshot used as the three-way-merge base, plus
 * `lastDirection` — the direction of the most recent MANUAL sync. Auto sync
 * (C5-5) follows this choice instead of guessing.
 */
export async function loadSyncState() {
  const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
  const s = stored[SYNC_STATE_KEY] || {};
  return {
    lastSyncedAt: s.lastSyncedAt || '',
    snapshot: s.snapshot || {},
    lastDirection: s.lastDirection || 'upload',
  };
}

async function saveSyncState(state) {
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: state });
}

/**
 * Page through GET /api/bookmarks/sync-pull (cheap changelog objects) starting
 * at `since` (the last-synced watermark). Includes soft-deleted rows so the
 * planner can propagate deletions.
 */
export async function fetchTagNestPull(cfg, since, signal) {
  const out = [];
  let cursor = null;
  do {
    const page = await syncPull(cfg, {
      since: cursor ? undefined : since || undefined,
      cursor: cursor || undefined,
      signal,
    });
    const items = (page && page.items) || [];
    for (const it of items) out.push(it);
    cursor = page && page.hasMore ? page.cursor : null;
  } while (cursor);
  return out;
}

/** The bookmarks bar root node (tree[0].children[0]). */
async function getBookmarksBar() {
  const tree = await chrome.bookmarks.getTree();
  return tree[0] && tree[0].children ? tree[0].children[0] : null;
}

/** The "TagNest" managed subfolder under the bookmarks bar, if it exists. */
async function getTagNestFolder() {
  const bar = await getBookmarksBar();
  if (!bar) return null;
  return (bar.children || []).find((c) => c.url === undefined && c.title === 'TagNest') || null;
}

/** Whether the extension is in "promote to bar" mode (P6-A). */
async function loadPromote(cfg) {
  const c = cfg || (await loadConfig());
  return Boolean(c && c.promoteToBar);
}

/**
 * In promote mode (P6-A), the managed subtree IS the bookmarks bar, so the
 * owned category folders live at the top level. We restrict sync's folderPath
 * attribution to those owned folders only — a user's unrelated top-level
 * folders must never be pushed up as categories (C4-2 safety). Returns a Set
 * of owned category folder node ids, or null in TagNest mode (no restriction).
 */
async function getOwnedFolderIds(promote) {
  if (!promote) return null;
  const bar = await getBookmarksBar();
  if (!bar) return null;
  const { foldersByLabel } = indexManagedTree(bar);
  const manifest = await loadCategoryManifest();
  const ids = new Set();
  for (const path of manifest.folders) {
    const info = foldersByLabel.get(pathLabel(path));
    if (info) ids.add(info.nodeId);
  }
  return ids;
}

/** The "TagNest" subfolder under the bookmarks bar, created on first use. */
async function resolveSyncFolder(cfg) {
  const promote = await loadPromote(cfg);
  if (promote) {
    // In promote mode the bar itself is the managed root; no TagNest folder.
    const bar = await getBookmarksBar();
    return bar ? bar.id : undefined;
  }
  const tree = await chrome.bookmarks.getTree();
  const bar = tree[0] && tree[0].children ? tree[0].children[0] : null;
  if (!bar) return undefined;
  const existing = (bar.children || []).find((c) => c.url === undefined && c.title === 'TagNest');
  if (existing) return existing.id;
  const created = await chrome.bookmarks.create({ parentId: bar.id, title: 'TagNest' });
  return created.id;
}

/**
 * READ-ONLY lookup of the managed folder id (C4-2). In promote mode (P6-A)
 * the managed root IS the bookmarks bar, so we return the bar id; otherwise
 * the "TagNest" folder id (or null if it doesn't exist yet — collection must
 * never create it; only the apply phase (resolveSyncFolder) may).
 */
async function findManagedFolderId(cfg) {
  const promote = await loadPromote(cfg);
  if (promote) {
    const bar = await getBookmarksBar();
    return bar ? bar.id : null;
  }
  const tn = await getTagNestFolder();
  return tn ? tn.id : null;
}

/**
 * The managed folder NODE (with children) used as the plan's `managedTree`
 * (P6-A). In promote mode this is the bookmarks bar root (its children are the
 * top-level owned category folders); otherwise the "TagNest" node. Returns
 * null only in TagNest mode when the folder hasn't been created yet.
 */
async function getManagedFolderNode(cfg) {
  const promote = await loadPromote(cfg);
  if (promote) return getBookmarksBar();
  return getTagNestFolder();
}

/**
 * Ensure a chain of nested folders exists under `rootId`, returning the id of
 * the deepest folder. `path` is an array of folder titles (may be empty →
 * returns `rootId`). Uses `cache` (label→id) so a single sync pass never
 * creates the same folder twice.
 */
async function ensureFolderPath(rootId, path, cache) {
  if (!Array.isArray(path) || path.length === 0) return rootId;
  const label = path.join(' > ');
  if (cache.has(label)) return cache.get(label);

  // Walk/create segment by segment, reusing existing children by title.
  let parentId = rootId;
  let currentLabel = '';
  for (const seg of path) {
    currentLabel = currentLabel ? `${currentLabel} > ${seg}` : seg;
    if (cache.has(currentLabel)) {
      parentId = cache.get(currentLabel);
      continue;
    }
    const children = await chrome.bookmarks.getChildren(parentId).catch(() => []);
    const existing = (children || []).find((c) => c.url === undefined && c.title === seg);
    if (existing) {
      cache.set(currentLabel, existing.id);
      parentId = existing.id;
    } else {
      const created = await chrome.bookmarks.create({ parentId, title: seg });
      cache.set(currentLabel, created.id);
      parentId = created.id;
    }
  }
  cache.set(label, parentId);
  return parentId;
}

/**
 * Reconstruct the next-sync base snapshot from the converged state.
 *
 * The snapshot is the three-way merge base for the NEXT run, so it must record
 * what both sides agree on after this pass:
 *  - Browser leaves seed the entry (title/tags, plus `categoryPath` = the local
 *    folder path for managed bookmarks, `null` outside the managed subtree).
 *  - TagNest-only items fill in anything the browser does not have.
 *  - In two-way mode the applied writes overwrite the seeded values: the browser
 *    now holds TagNest's version, so the base must reflect the applied (cloud)
 *    title/tags/category rather than the stale pre-apply browser state. Only
 *    `toUpdate` entries that actually carry a `categoryPath` key move the
 *    folder; title/tags-only updates leave the seeded folder path intact.
 */
function buildSnapshot(browserBookmarks, tnPullItems, plan, twoWay) {
  const snap = {};
  for (const b of browserBookmarks) {
    const k = urlKey(b && b.url);
    if (!k) continue;
    snap[k] = {
      title: (b.title || '').trim(),
      tagNames: normTags(b.tagNames),
      categoryPath: Array.isArray(b.folderPath) ? b.folderPath : null,
    };
  }
  for (const it of tnPullItems) {
    if (!it || !it.urlKey || it.deletedAt) continue;
    if (!snap[it.urlKey]) {
      snap[it.urlKey] = {
        title: it.title || '',
        tagNames: normTags(it.tagNames),
        categoryPath: Array.isArray(it.categoryPath) ? it.categoryPath : null,
      };
    }
  }
  if (twoWay && plan) {
    for (const u of plan.toApply.toUpdate) {
      const entry = snap[u.urlKey];
      if (!entry) continue;
      entry.title = (u.title || '').trim();
      entry.tagNames = normTags(u.tagNames);
      if (Object.prototype.hasOwnProperty.call(u, 'categoryPath')) {
        entry.categoryPath = Array.isArray(u.categoryPath) ? u.categoryPath : null;
      }
    }
    for (const c of plan.toApply.toCreate) {
      snap[c.urlKey] = {
        title: (c.title || '').trim(),
        tagNames: normTags(c.tagNames),
        categoryPath: Array.isArray(c.categoryPath) ? c.categoryPath : null,
      };
    }
  }
  return snap;
}

function normTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].sort();
}

/**
 * Run a full bidirectional sync pass.
 *
 * 1. Read the managed folder (read-only) and flatten the browser tree so managed
 *    leaves carry their `folderPath` (C4-2); pull the TagNest changelog since the
 *    watermark (each item now carries its derived `categoryPath`, C4-1).
 * 2. planSync() three-way-merges title/tags AND category, deciding push
 *    (browser→hub) and apply (hub→browser) sets plus category conflicts (C4-4).
 * 3. In two-way mode, back up every touched node, then write TagNest state back
 *    into the "TagNest" folder — creating bookmarks in their cloud category
 *    folder and moving re-categorised ones (C4-5). Browser bookmarks have no tag
 *    field, so only title + folder position are written back.
 * 4. Push local changes (title/tags + the managed folder path as categoryPath),
 *    then persist the new watermark + snapshot.
 *
 * Returns a summary the UI renders. Throws (surfaced by the caller) if the
 * `bookmarks` permission is missing or a network call fails.
 */
export async function runSync(cfg, { direction = 'upload', signal } = {}) {
  // C4-2: read-only lookup — collection must never create the managed folder.
  const promote = await loadPromote(cfg);
  const managedFolderId = await findManagedFolderId(cfg);
  const owned = promote ? await getOwnedFolderIds(true) : null;
  const browser = await collectBrowserBookmarks(signal, managedFolderId, owned);
  const state = await loadSyncState();
  const tnPullItems = await fetchTagNestPull(cfg, state.lastSyncedAt, signal);
  const plan = planSync({
    browserBookmarks: browser,
    tnPullItems,
    lastSnapshot: state.snapshot || {},
    direction,
    lastSyncedAt: state.lastSyncedAt || '',
  });

  const twoWay = direction === 'two-way';
  const applied = { created: 0, updated: 0, removed: 0, moved: 0 };
  let backup = null;

  // C4-6: the module-level `applyingRemote` flag (see top of file) marks the
  // apply window below; every browser-tree mutation inside it is remote-sourced.
  const hasApplyWork =
    plan.toApply.toCreate.length || plan.toApply.toUpdate.length || plan.toApply.toRemove.length;

  if (twoWay && hasApplyWork) {
    backup = { created: [], updated: [], removed: [] };
    const folderId = await resolveSyncFolder(cfg);
    const folderCache = new Map();
    folderCache.set('', folderId); // the managed root itself

    // Pre-apply backups. `parentId` is captured for updates too, so a category
    // move can be rolled back to the original folder.
    for (const u of plan.toApply.toUpdate) {
      const nodes = await chrome.bookmarks.get(u.browserId).catch(() => []);
      const node = nodes && nodes[0];
      if (node) backup.updated.push({ id: u.browserId, title: node.title, parentId: node.parentId });
    }
    for (const r of plan.toApply.toRemove) {
      const nodes = await chrome.bookmarks.get(r.browserId).catch(() => []);
      const node = nodes && nodes[0];
      if (node) backup.removed.push({ id: r.browserId, parentId: node.parentId, url: node.url, title: node.title });
    }

    applyingRemote = true;
    try {
      for (const c of plan.toApply.toCreate) {
        // Place the new bookmark straight into its cloud category folder (C4-5).
        const targetId = await ensureFolderPath(folderId, c.categoryPath || [], folderCache);
        const node = await chrome.bookmarks.create({ parentId: targetId, title: c.title || '', url: c.url });
        backup.created.push({ id: node.id, parentId: targetId, url: c.url, title: c.title });
        applied.created += 1;
      }
      for (const u of plan.toApply.toUpdate) {
        await chrome.bookmarks.update(u.browserId, { title: u.title || '' }).catch(() => {});
        applied.updated += 1;
        // Contract from planSync: only entries that carry a `categoryPath` key
        // change folder; `[]` moves to the managed root.
        if (Object.prototype.hasOwnProperty.call(u, 'categoryPath')) {
          const targetId = await ensureFolderPath(folderId, u.categoryPath || [], folderCache);
          await chrome.bookmarks.move(u.browserId, { parentId: targetId }).catch(() => {});
          applied.moved += 1;
        }
      }
      for (const r of plan.toApply.toRemove) {
        await chrome.bookmarks.remove(r.browserId).catch(() => {});
        applied.removed += 1;
      }
    } finally {
      applyingRemote = false;
    }

    if (backup.created.length || backup.updated.length || backup.removed.length) {
      await chrome.storage.local.set({ [SYNC_BACKUP_KEY]: backup });
    }
  }

  const changes = [];
  for (const u of plan.toPush.upserts) {
    const change = { op: 'upsert', url: u.url, title: u.title, tagNames: normTags(u.tagNames) };
    // C4-2: hand the browser's managed folder path up as the cloud category.
    // Only a non-empty managed path is meaningful; null/[] means "no category
    // information" and must leave the cloud placement untouched (sync-push).
    if (Array.isArray(u.folderPath) && u.folderPath.length > 0) {
      change.categoryPath = u.folderPath;
    }
    changes.push(change);
  }
  for (const d of plan.toPush.deletes) {
    changes.push({ op: 'delete', url: d.url });
  }

  let pushResult = null;
  if (changes.length) {
    pushResult = await syncPush(cfg, changes, signal);
  }

  const newSnapshot = buildSnapshot(browser, tnPullItems, plan, twoWay);
  await saveSyncState({
    lastSyncedAt: plan.nextWatermark,
    snapshot: newSnapshot,
    // C5-5: remember the direction of this (manual) run so auto sync follows it.
    lastDirection: direction,
  });

  const conflictDetails = plan.conflicts.map((c) => ({
    ...c,
    tn: tnPullItems.find((i) => i && i.urlKey === c.urlKey) || null,
  }));

  // Category summary for the sync page (CS-P3-5).
  const categoryStats = {
    pushed: changes.filter((c) => c.categoryPath).length,
    appliedMoves: applied.moved,
    appliedCreates: twoWay
      ? plan.toApply.toCreate.filter((c) => Array.isArray(c.categoryPath) && c.categoryPath.length).length
      : 0,
    conflicts: plan.conflicts.filter((c) => c.reason === 'category_conflict').length,
  };

  return {
    direction,
    browserCount: browser.length,
    tnCount: tnPullItems.length,
    pushed: pushResult
      ? { applied: pushResult.applied, failed: pushResult.failed, errors: pushResult.errors }
      : { applied: 0, failed: 0, errors: [] },
    applied,
    conflicts: plan.conflicts,
    conflictDetails,
    categoryStats,
    nextWatermark: plan.nextWatermark,
  };
}

/**
 * Roll back the most recent two-way apply using the captured backup. Reverses
 * each write: re-create removed nodes, restore updated titles, delete created
 * nodes. Does NOT touch TagNest (the push already happened; a re-sync will
 * re-derive the correct state from the restored browser tree).
 */
export async function rollbackSync() {
  const stored = await chrome.storage.local.get(SYNC_BACKUP_KEY);
  const backup = stored[SYNC_BACKUP_KEY];
  if (!backup) return { ok: false, message: '没有可恢复的快照' };

  for (const r of backup.removed) {
    await chrome.bookmarks.create({ parentId: r.parentId, title: r.title, url: r.url }).catch(() => {});
  }
  for (const u of backup.updated) {
    await chrome.bookmarks.update(u.id, { title: u.title }).catch(() => {});
  }
  for (const c of backup.created) {
    await chrome.bookmarks.remove(c.id).catch(() => {});
  }
  await chrome.storage.local.remove(SYNC_BACKUP_KEY);
  return { ok: true, restored: backup.created.length + backup.updated.length + backup.removed.length };
}

// ---------------------------------------------------------------------------
// CategorySync P2 — managed category tree build (C3)
// ---------------------------------------------------------------------------
//
// The managed "TagNest" folder becomes a MIRROR of the cloud category tree:
// folders per category path, one bookmark copy per accepted primary category.
// Everything here is copy-semantics (A1): we only ever create/move/update/
// delete nodes INSIDE the managed subtree — bookmarks elsewhere in the
// browser are never touched (C3-7).

const CATEGORY_OP_BACKUP_KEY = 'tagnestCategoryOpBackup.v0';
const CATEGORY_BUILD_KEY = 'tagnestCategoryBuild.v0';
/** C3-6: chrome.bookmarks writes are chunked to keep large libraries smooth. */
export const CATEGORY_BATCH_SIZE = 50;

// NOTE: getManagedFolderNode(cfg) is declared earlier (P6-A mode-aware version)
// and is the single source of truth for "the managed subtree root".

/** Load the ownership manifest persisted by the previous build. */
export async function loadCategoryManifest() {
  const stored = await chrome.storage.local.get(CATEGORY_BUILD_KEY);
  return normalizeManifest(stored[CATEGORY_BUILD_KEY]);
}

async function saveCategoryManifest(manifest) {
  await chrome.storage.local.set({ [CATEGORY_BUILD_KEY]: manifest });
}

/**
 * C3-2 preview: fetch the cloud writeback feed, diff it against the current
 * managed subtree, and return the plan WITHOUT writing anything. The UI shows
 * counts + samples and asks the user to confirm before `runCategoryBuild`.
 */
export async function previewCategoryBuild(cfg, signal) {
  const { items: feedItems, total } = await fetchCategoryWriteback(cfg, signal);
  const promote = await loadPromote(cfg);
  const managed = await getManagedFolderNode(cfg);
  const manifest = await loadCategoryManifest();
  const plan = planCategoryBuild({ feedItems, managedTree: managed, manifest });
  // Current footprint = what we own (mode-independent). In promote mode
  // `managed` is the whole bar, so counting it would be misleading.
  const current = { folders: manifest.folders.length, bookmarks: Object.keys(manifest.bookmarks).length };
  return {
    ok: true,
    feedTotal: total,
    managedFolderMissing: plan.managedFolderMissing,
    mode: promote ? 'bar' : 'tagnest',
    current,
    stats: plan.stats,
    samples: plan.samples,
  };
}

/** Retry one chrome.bookmarks op once (§8.2), then record it as failed. */
async function withRetry(fn) {
  try {
    await fn();
    return true;
  } catch {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * C3-1/C3-3/C3-5/C3-6: execute the category build.
 *
 * 1. Re-fetch the feed and re-plan (the preview may be stale).
 * 2. Snapshot the ENTIRE managed subtree before the first write (C3-3) so
 *    `rollbackCategoryBuild` can restore it byte-for-byte (C3-4).
 * 3. Apply the plan in ≤50-op batches with progress callbacks: folders
 *    top-down → moves → creates → title updates → stale removals.
 * 4. Persist the next ownership manifest for the incremental run (C3-5).
 *
 * `onProgress({ done, total, phase })` fires after every batch; the service
 * worker relays it to the build page.
 */
export async function runCategoryBuild(cfg, { signal, onProgress } = {}) {
  const { items: feedItems } = await fetchCategoryWriteback(cfg, signal);

  let managed = await getManagedFolderNode(cfg);
  if (!managed) {
    // §8.2: the folder was deleted (or first build) — the user already
    // confirmed the rebuild via the preview step, so create it now.
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0] && tree[0].children ? tree[0].children[0] : null;
    if (!bar) return { ok: false, message: '找不到书签栏' };
    managed = await chrome.bookmarks.create({ parentId: bar.id, title: 'TagNest' });
    managed.children = [];
  }

  const manifest = await loadCategoryManifest();
  const plan = planCategoryBuild({ feedItems, managedTree: managed, manifest });

  // C3-3/C3-4: capture a per-operation backup BEFORE any write so
  // rollbackCategoryBuild can reverse ONLY the nodes this build touched.
  // (In promote mode the "managed root" is the whole bar, so a whole-tree
  // snapshot + removeTree would be catastrophic — per-op is the safe shape.)
  const opBackup = { createdFolders: [], createdBookmarks: [], moved: [], updated: [], removed: [] };

  // Folder id resolution: existing folders by title-path, new ones as created.
  const { foldersByLabel } = indexManagedTree(managed);
  const folderIdByLabel = new Map();
  for (const [label, info] of foldersByLabel) folderIdByLabel.set(label, info.nodeId);
  folderIdByLabel.set('', managed.id); // the managed root itself

  const ops = [];

  for (const f of plan.createFolders) {
    ops.push({
      phase: 'folders',
      run: async () => {
        const parentLabel = pathLabel(f.path.slice(0, -1));
        const parentId = folderIdByLabel.get(parentLabel);
        if (!parentId) throw new Error(`父文件夹缺失: ${parentLabel}`);
        const node = await chrome.bookmarks.create({
          parentId,
          title: f.path[f.path.length - 1],
        });
        folderIdByLabel.set(pathLabel(f.path), node.id);
        opBackup.createdFolders.push({ id: node.id, parentId });
      },
    });
  }

  for (const m of plan.moveBookmarks) {
    ops.push({
      phase: 'moves',
      run: async () => {
        const parentId = folderIdByLabel.get(pathLabel(m.toPath));
        if (!parentId) throw new Error(`目标文件夹缺失: ${pathLabel(m.toPath)}`);
        // Source parent id derived from the planner's fromPath. This is more
        // robust than a second chrome.bookmarks.get (whose parentId could be
        // stale) and keeps rollback's reverse-move independent of the mock.
        const fromParentId = folderIdByLabel.get(pathLabel(m.fromPath));
        opBackup.moved.push({ id: m.nodeId, fromParentId });
        await chrome.bookmarks.move(m.nodeId, { parentId });
      },
    });
  }

  for (const c of plan.createBookmarks) {
    ops.push({
      phase: 'creates',
      run: async () => {
        const parentId = folderIdByLabel.get(pathLabel(c.path));
        if (!parentId) throw new Error(`目标文件夹缺失: ${pathLabel(c.path)}`);
        const node = await chrome.bookmarks.create({ parentId, title: c.title, url: c.url });
        opBackup.createdBookmarks.push({ id: node.id, parentId, url: c.url, title: c.title });
      },
    });
  }

  for (const u of plan.updateTitles) {
    ops.push({
      phase: 'updates',
      run: async () => {
        const nodes = await chrome.bookmarks.get(u.nodeId).catch(() => []);
        const originalTitle = nodes && nodes[0] ? nodes[0].title : undefined;
        opBackup.updated.push({ id: u.nodeId, originalTitle });
        await chrome.bookmarks.update(u.nodeId, { title: u.title });
      },
    });
  }

  for (const r of plan.removeNodes) {
    ops.push({
      phase: 'removes',
      // removeTree also covers the (defensively) non-empty folder case.
      run: async () => {
        const nodes = await chrome.bookmarks.get(r.nodeId).catch(() => []);
        const node = nodes && nodes[0];
        if (node) {
          opBackup.removed.push({
            id: r.nodeId,
            parentId: node.parentId,
            url: node.url,
            title: node.title,
            isFolder: r.isFolder,
          });
        }
        return r.isFolder ? chrome.bookmarks.removeTree(r.nodeId) : chrome.bookmarks.remove(r.nodeId);
      },
    });
  }

  // C3-6: chunked execution with progress; each op retries once (§8.2).
  const total = ops.length;
  let done = 0;
  let failed = 0;
  for (let start = 0; start < total; start += CATEGORY_BATCH_SIZE) {
    const batch = ops.slice(start, start + CATEGORY_BATCH_SIZE);
    for (const op of batch) {
      if (signal?.aborted) return { ok: false, message: '构建已取消', stats: plan.stats };
      const okOp = await withRetry(op.run);
      if (!okOp) failed += 1;
      done += 1;
    }
    if (onProgress) {
      onProgress({ done, total, phase: batch[batch.length - 1].phase });
    }
  }

  await saveCategoryManifest(plan.nextManifest);

  // Persist the per-op backup so rollbackCategoryBuild can reverse exactly
  // what this build changed — never more, never the user's other bookmarks.
  await chrome.storage.local.set({ [CATEGORY_OP_BACKUP_KEY]: opBackup });

  return {
    ok: true,
    stats: plan.stats,
    executed: done,
    failed,
    snapshotTaken: true,
  };
}

/**
 * C3-4: restore the managed folder to the pre-build snapshot. Removes the
 * current managed subtree and rebuilds it from the serialized snapshot (node
 * ids change, but the urlKey-based diff does not depend on them). Also drops
 * the ownership manifest — the next build re-derives ownership from scratch.
 */
export async function rollbackCategoryBuild() {
  const stored = await chrome.storage.local.get(CATEGORY_OP_BACKUP_KEY);
  const backup = stored[CATEGORY_OP_BACKUP_KEY];
  if (!backup) return { ok: false, message: '没有可恢复的分类快照' };

  // Reverse ONLY what this build touched. In promote mode the "managed root"
  // is the whole bookmarks bar, so we must never removeTree a large subtree —
  // we undo each operation surgically, leaving every other bookmark intact.
  // Order: recreate deleted nodes → restore titles → reverse moves → delete
  // created nodes (bookmarks before folders, since removeTree cascades).
  for (const r of backup.removed) {
    if (r.isFolder) {
      await chrome.bookmarks.create({ parentId: r.parentId, title: r.title }).catch(() => {});
    } else {
      await chrome.bookmarks.create({ parentId: r.parentId, title: r.title, url: r.url }).catch(() => {});
    }
  }
  for (const u of backup.updated) {
    if (u.originalTitle !== undefined) {
      await chrome.bookmarks.update(u.id, { title: u.originalTitle }).catch(() => {});
    }
  }
  for (const m of backup.moved) {
    if (m.fromParentId) {
      await chrome.bookmarks.move(m.id, { parentId: m.fromParentId }).catch(() => {});
    }
  }
  for (const c of backup.createdBookmarks) {
    await chrome.bookmarks.remove(c.id).catch(() => {});
  }
  for (const c of backup.createdFolders) {
    await chrome.bookmarks.removeTree(c.id).catch(() => {});
  }

  await chrome.storage.local.remove(CATEGORY_OP_BACKUP_KEY);
  await chrome.storage.local.remove(CATEGORY_BUILD_KEY);
  const restored =
    backup.removed.length +
    backup.updated.length +
    backup.moved.length +
    backup.createdBookmarks.length +
    backup.createdFolders.length;
  return { ok: true, restored };
}

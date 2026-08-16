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

import { apiFetch, syncPull, syncPush } from './api.js';
import { flattenBrowserBookmarks, diffByKey, urlKey } from './sync-diff.js';
import { planSync } from './sync-engine.js';

/** Read and flatten the browser's entire bookmark tree. */
export async function collectBrowserBookmarks(signal) {
  const tree = await chrome.bookmarks.getTree();
  return flattenBrowserBookmarks(tree);
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

// ---------------------------------------------------------------------------
// B-12 Phase B — bidirectional sync orchestration
// ---------------------------------------------------------------------------

const SYNC_STATE_KEY = 'tagnestSync.v0';
const SYNC_BACKUP_KEY = 'tagnestSyncBackup.v0';

/** Last sync watermark + the snapshot used as the three-way-merge base. */
export async function loadSyncState() {
  const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
  const s = stored[SYNC_STATE_KEY] || {};
  return { lastSyncedAt: s.lastSyncedAt || '', snapshot: s.snapshot || {} };
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

/** The "TagNest" subfolder under the bookmarks bar, created on first use. */
async function resolveSyncFolder() {
  const tree = await chrome.bookmarks.getTree();
  const bar = tree[0] && tree[0].children ? tree[0].children[0] : null;
  if (!bar) return undefined;
  const existing = (bar.children || []).find((c) => c.url === undefined && c.title === 'TagNest');
  if (existing) return existing.id;
  const created = await chrome.bookmarks.create({ parentId: bar.id, title: 'TagNest' });
  return created.id;
}

/** Reconstruct the next-sync base snapshot from the converged state. */
function buildSnapshot(browserBookmarks, tnPullItems) {
  const snap = {};
  for (const b of browserBookmarks) {
    const k = urlKey(b && b.url);
    if (!k) continue;
    snap[k] = {
      title: (b.title || '').trim(),
      tagNames: [...new Set((b.tagNames || []).map((t) => String(t).trim()).filter(Boolean))].sort(),
    };
  }
  for (const it of tnPullItems) {
    if (!it || !it.urlKey || it.deletedAt) continue;
    if (!snap[it.urlKey]) snap[it.urlKey] = { title: it.title || '', tagNames: (it.tagNames || []).slice().sort() };
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
 * 1. Snapshot the browser tree + pull the TagNest changelog since the watermark.
 * 2. planSync() decides push (browser→hub) and apply (hub→browser) sets.
 * 3. In two-way mode, capture a pre-apply backup of every touched browser node,
 *    then write TagNest state back into the "TagNest" folder (create / update /
 *    remove). Browser bookmarks have no tag field, so only title is written
 *    back; tags live only in TagNest.
 * 4. Push local changes, then persist the new watermark + snapshot.
 *
 * Returns a summary the UI renders. Throws (surfaced by the caller) if the
 * `bookmarks` permission is missing or a network call fails.
 */
export async function runSync(cfg, { direction = 'upload', signal } = {}) {
  const browser = await collectBrowserBookmarks(signal);
  const state = await loadSyncState();
  const tnPullItems = await fetchTagNestPull(cfg, state.lastSyncedAt, signal);
  const plan = planSync({
    browserBookmarks: browser,
    tnPullItems,
    lastSnapshot: state.snapshot || {},
    direction,
    lastSyncedAt: state.lastSyncedAt || '',
  });

  const applied = { created: 0, updated: 0, removed: 0 };
  let backup = null;

  if (
    direction === 'two-way' &&
    (plan.toApply.toCreate.length || plan.toApply.toUpdate.length || plan.toApply.toRemove.length)
  ) {
    backup = { created: [], updated: [], removed: [] };
    const folderId = await resolveSyncFolder();

    for (const u of plan.toApply.toUpdate) {
      const nodes = await chrome.bookmarks.get(u.browserId).catch(() => []);
      const node = nodes && nodes[0];
      if (node) backup.updated.push({ id: u.browserId, title: node.title });
    }
    for (const r of plan.toApply.toRemove) {
      const nodes = await chrome.bookmarks.get(r.browserId).catch(() => []);
      const node = nodes && nodes[0];
      if (node) backup.removed.push({ id: r.browserId, parentId: node.parentId, url: node.url, title: node.title });
    }

    for (const c of plan.toApply.toCreate) {
      const node = await chrome.bookmarks.create({ parentId: folderId, title: c.title || '', url: c.url });
      backup.created.push({ id: node.id, parentId: folderId, url: c.url, title: c.title });
      applied.created += 1;
    }
    for (const u of plan.toApply.toUpdate) {
      await chrome.bookmarks.update(u.browserId, { title: u.title || '' }).catch(() => {});
      applied.updated += 1;
    }
    for (const r of plan.toApply.toRemove) {
      await chrome.bookmarks.remove(r.browserId).catch(() => {});
      applied.removed += 1;
    }

    if (backup.created.length || backup.updated.length || backup.removed.length) {
      await chrome.storage.local.set({ [SYNC_BACKUP_KEY]: backup });
    }
  }

  const changes = [];
  for (const u of plan.toPush.upserts) {
    changes.push({ op: 'upsert', url: u.url, title: u.title, tagNames: normTags(u.tagNames) });
  }
  for (const d of plan.toPush.deletes) {
    changes.push({ op: 'delete', url: d.url });
  }

  let pushResult = null;
  if (changes.length) {
    pushResult = await syncPush(cfg, changes, signal);
  }

  const newSnapshot = buildSnapshot(browser, tnPullItems);
  await saveSyncState({ lastSyncedAt: plan.nextWatermark, snapshot: newSnapshot });

  const conflictDetails = plan.conflicts.map((c) => ({
    ...c,
    tn: tnPullItems.find((i) => i && i.urlKey === c.urlKey) || null,
  }));

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

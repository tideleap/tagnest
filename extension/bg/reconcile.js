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

import { apiFetch } from './api.js';
import { flattenBrowserBookmarks, diffByKey } from './sync-diff.js';

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

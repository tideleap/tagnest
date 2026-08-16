// TagNest extension — sync engine (B-12, Phase B).
//
// Pure, side-effect-free planning for two-way bookmark sync. It takes the
// current browser state, the latest TagNest changelog pulled from the hub, and
// the last-synced snapshot (the three-way merge base) and decides:
//   - `toPush`  — changes to send browser → TagNest (upload + two-way)
//   - `toApply` — changes to write TagNest → browser (two-way only)
//   - `conflicts` — keys where both sides diverged and a human must decide
//   - `nextWatermark` — the `updated_at` to persist for the next incremental pull
//
// The engine never touches `chrome.*` or the network, so it is importable from
// the backend Vitest suite and asserted in isolation. All three-way decisions
// use the snapshot as the common ancestor, which makes a first sync (empty
// snapshot) converge without spurious churn: a urlKey present on both sides is
// treated as already-synced, and only locally-or-remotely *changed* keys move.

import { urlKey } from './sync-diff.js';

/** Normalise a tag-name list: trimmed, de-duped, sorted, lower-noise. */
function normTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].sort();
}

function tagsDiffer(a, b) {
  const x = normTags(a);
  const y = normTags(b);
  if (x.length !== y.length) return true;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return true;
  return false;
}

/**
 * Highest `updated_at` seen in the pulled changelog, used as the next incremental
 * pull watermark. `since` is inclusive, so re-pulling the boundary row is
 * idempotent. Falls back to `lastSyncedAt` when nothing was pulled.
 */
export function computeWatermark(tnPullItems, lastSyncedAt) {
  let max = lastSyncedAt || '';
  for (const it of tnPullItems || []) {
    if (it && it.updatedAt && it.updatedAt > max) max = it.updatedAt;
  }
  return max;
}

/**
 * @param {object} args
 * @param {Array<{id:string,url:string,title?:string,tagNames?:string[],dateAdded?:number}>} args.browserBookmarks
 *   Flat list of browser bookmark leaves (see flattenBrowserBookmarks).
 * @param {Array<{id:string,urlKey:string,url:string,title?:string,tagNames?:string[],updatedAt?:string,deletedAt?:string|null}>} args.tnPullItems
 *   Changelog from GET /api/bookmarks/sync-pull (includes soft-deleted rows).
 * @param {Record<string,{title?:string,tagNames?:string[]}>} [args.lastSnapshot]
 *   Last-synced common ancestor, keyed by urlKey.
 * @param {'upload'|'two-way'} [args.direction] `upload` pushes browser→TN only;
 *   `two-way` also writes TN→browser and flags hard conflicts.
 * @param {string} [args.lastSyncedAt] watermark from the previous sync.
 */
export function planSync({
  browserBookmarks = [],
  tnPullItems = [],
  lastSnapshot = {},
  direction = 'upload',
  lastSyncedAt = '',
} = {}) {
  const twoWay = direction === 'two-way';

  const browserByKey = new Map();
  for (const b of browserBookmarks) {
    const key = urlKey(b && b.url);
    if (!key) continue;
    browserByKey.set(key, {
      id: b.id,
      url: b.url,
      title: (b.title || '').trim(),
      tagNames: normTags(b.tagNames),
      dateAdded: b.dateAdded ?? null,
    });
  }

  const tnByKey = new Map();
  for (const it of tnPullItems) {
    if (!it || !it.urlKey) continue;
    tnByKey.set(it.urlKey, {
      id: it.id,
      url: it.url,
      title: (it.title || '').trim(),
      tagNames: normTags(it.tagNames),
      deletedAt: it.deletedAt ?? null,
      updatedAt: it.updatedAt ?? '',
    });
  }

  const base = lastSnapshot || {};

  const toPush = { upserts: [], deletes: [] };
  const toApply = { toCreate: [], toUpdate: [], toRemove: [] };
  const conflicts = [];

  const keys = new Set([...browserByKey.keys(), ...tnByKey.keys()]);

  for (const key of keys) {
    const b = browserByKey.get(key) || null;
    const t = tnByKey.get(key) || null;
    const baseEntry = base[key] || null;
    const baseTitle = baseEntry ? (baseEntry.title || '').trim() : null;
    const baseTags = baseEntry ? normTags(baseEntry.tagNames) : null;

    // --- Only in the browser ------------------------------------------
    if (b && !t) {
      if (baseEntry) {
        const bTitleChanged = b.title !== baseTitle;
        const bTagsChanged = tagsDiffer(b.tagNames, baseTags);
        if (bTitleChanged || bTagsChanged) {
          toPush.upserts.push(b); // local edit/addition → propagate up
        } else if (twoWay) {
          toApply.toRemove.push({ urlKey: key, browserId: b.id }); // TN removed it; mirror
        }
      } else {
        toPush.upserts.push(b); // brand-new local bookmark
      }
      continue;
    }

    // --- Only in TagNest ----------------------------------------------
    if (!b && t) {
      if (baseEntry) {
        if (!t.deletedAt) {
          toPush.deletes.push({ urlKey: key, url: t.url }); // browser removed it; delete in TN
        }
        // TN also deleted (or never resurfaced): nothing to do.
      } else if (!t.deletedAt && twoWay) {
        toApply.toCreate.push({ urlKey: key, url: t.url, title: t.title, tagNames: t.tagNames });
      }
      continue;
    }

    if (!b || !t) continue;

    // --- TN soft-deleted, browser still live -------------------------
    if (t.deletedAt) {
      const bTitleChanged = baseEntry ? b.title !== baseTitle : true;
      const bTagsChanged = baseEntry ? tagsDiffer(b.tagNames, baseTags) : true;
      if (!bTitleChanged && !bTagsChanged) {
        if (twoWay) toApply.toRemove.push({ urlKey: key, browserId: b.id });
      } else {
        toPush.upserts.push(b); // local edit wins over the TN deletion
        if (twoWay) conflicts.push({ urlKey: key, reason: 'deleted_in_tagnest_but_modified_locally' });
      }
      continue;
    }

    // --- Both live: field-level last-write-wins ----------------------
    const bTitleChanged = baseEntry ? b.title !== baseTitle : false;
    const bTagsChanged = baseEntry ? tagsDiffer(b.tagNames, baseTags) : false;
    const tTitleChanged = baseEntry ? t.title !== baseTitle : false;
    const tTagsChanged = baseEntry ? tagsDiffer(t.tagNames, baseTags) : false;

    if (!bTitleChanged && !bTagsChanged && !tTitleChanged && !tTagsChanged) {
      continue; // converged
    }

    if (bTitleChanged || bTagsChanged) {
      toPush.upserts.push(b); // local change → push up
    }

    if (twoWay && (tTitleChanged || tTagsChanged)) {
      if (!bTitleChanged && !bTagsChanged) {
        toApply.toUpdate.push({ urlKey: key, browserId: b.id, title: t.title, tagNames: t.tagNames });
      } else {
        const titleConflict = bTitleChanged && tTitleChanged && b.title !== t.title;
        const tagsConflict = bTagsChanged && tTagsChanged && tagsDiffer(b.tagNames, t.tagNames);
        if (titleConflict || tagsConflict) {
          conflicts.push({
            urlKey: key,
            reason: 'both_modified',
            fields: { title: titleConflict, tags: tagsConflict },
          });
          // Browser version already pushed; do not auto-clobber it with TN's.
        }
      }
    }
  }

  return {
    toPush,
    toApply,
    conflicts,
    nextWatermark: computeWatermark(tnPullItems, lastSyncedAt),
  };
}

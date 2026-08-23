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
//
// Category dimension (C4-4, folder-aware sync): alongside title/tags, each
// leaf carries a category — the browser side as `folderPath` (folder titles
// below the managed root, CS-P3-3) and the cloud side as `categoryPath`
// (derived primary-category path, CS-P3-1). Categories merge three-way like
// the other fields, with two twists: a local "no info" state (outside the
// managed subtree, or parked at the managed root) never counts as a change,
// and when both sides re-categorised differently the LOCAL manual move wins
// upward (D5) while the cloud suggestion is surfaced as a
// `category_conflict` entry for manual review — never auto-applied.

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
 * Normalise a category path for comparison: trimmed segments, empties
 * dropped. `null`/`undefined`/non-arrays normalise to `null` — "no category
 * information" — which is distinct from `[]` (explicitly uncategorised /
 * parked at the managed root).
 */
function normPath(p) {
  if (!Array.isArray(p)) return null;
  const segs = p.map((s) => String(s ?? '').trim()).filter(Boolean);
  return segs.length ? segs : [];
}

function pathsEqual(a, b) {
  const x = normPath(a);
  const y = normPath(b);
  if (x === null || y === null) return x === y;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
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
 * @param {Array<{id:string,url:string,title?:string,tagNames?:string[],dateAdded?:number,folderPath?:string[]|null}>} args.browserBookmarks
 *   Flat list of browser bookmark leaves (see flattenBrowserBookmarks).
 *   `folderPath` (C4-2) is the folder-title path below the managed root for
 *   leaves inside the managed subtree, `null` outside it.
 * @param {Array<{id:string,urlKey:string,url:string,title?:string,tagNames?:string[],categoryPath?:string[]|null,updatedAt?:string,deletedAt?:string|null}>} args.tnPullItems
 *   Changelog from GET /api/bookmarks/sync-pull (includes soft-deleted rows).
 *   `categoryPath` (C4-1) is the cloud's derived primary-category path.
 * @param {Record<string,{title?:string,tagNames?:string[],categoryPath?:string[]|null}>} [args.lastSnapshot]
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
      folderPath: normPath(b.folderPath),
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
      categoryPath: normPath(it.categoryPath),
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
    const baseCategory = baseEntry ? normPath(baseEntry.categoryPath) : null;

    // Category change detection (C4-4). The browser side only counts as
    // changed when the leaf sits inside the managed subtree (folderPath is an
    // array) AND carries a non-empty path: moving a bookmark OUT of the
    // managed tree, or parking it at the managed root, expresses "no category
    // information" — mirroring sync-push, which leaves placements untouched
    // for `[]`/`null` — so it must never push an "uncategorise" upward.
    //
    // Without a snapshot there is no merge base, so fall back to comparing
    // the two live sides directly: equal paths are already converged (no
    // churn), different paths both claim a category and resolve as a conflict
    // with local precedence (D5).
    const bCategoryChanged =
      b !== null &&
      Array.isArray(b.folderPath) &&
      b.folderPath.length > 0 &&
      (baseEntry
        ? !pathsEqual(b.folderPath, baseCategory)
        : t === null || !pathsEqual(b.folderPath, t.categoryPath));
    // Cloud side: with a base, any divergence counts (including a cleared
    // placement — that is a real change from the ancestor). Without a base,
    // `null` means "never categorised" — no opinion, not a change — so only
    // an actual path can claim a change on the first sync.
    const tCategoryChanged =
      t !== null &&
      (baseEntry
        ? !pathsEqual(t.categoryPath, baseCategory)
        : t.categoryPath !== null && (b === null || !pathsEqual(t.categoryPath, b.folderPath)));

    // --- Only in the browser ------------------------------------------
    if (b && !t) {
      if (baseEntry) {
        const bTitleChanged = b.title !== baseTitle;
        const bTagsChanged = tagsDiffer(b.tagNames, baseTags);
        if (bTitleChanged || bTagsChanged || bCategoryChanged) {
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
        toApply.toCreate.push({
          urlKey: key,
          url: t.url,
          title: t.title,
          tagNames: t.tagNames,
          categoryPath: t.categoryPath,
        });
      }
      continue;
    }

    if (!b || !t) continue;

    // --- TN soft-deleted, browser still live -------------------------
    if (t.deletedAt) {
      const bTitleChanged = baseEntry ? b.title !== baseTitle : true;
      const bTagsChanged = baseEntry ? tagsDiffer(b.tagNames, baseTags) : true;
      const bAnyChanged = bTitleChanged || bTagsChanged || bCategoryChanged;
      if (!bAnyChanged) {
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

    // Category changes only flow for leaves INSIDE the managed subtree:
    // outside it `folderPath` is null ("no category information"), and a
    // cloud re-categorisation must not drag an unmanaged bookmark into the
    // managed folder — bulk placement is the category build's job (C3), not
    // incremental sync's.
    const inManaged = Array.isArray(b.folderPath);
    const tCategoryApplies = tCategoryChanged && inManaged;

    if (
      !bTitleChanged && !bTagsChanged && !bCategoryChanged &&
      !tTitleChanged && !tTagsChanged && !tCategoryApplies
    ) {
      continue; // converged
    }

    if (bTitleChanged || bTagsChanged || bCategoryChanged) {
      toPush.upserts.push(b); // local change → push up
    }

    if (twoWay && (tTitleChanged || tTagsChanged || tCategoryApplies)) {
      const bAnyChanged = bTitleChanged || bTagsChanged || bCategoryChanged;
      if (!bAnyChanged) {
        toApply.toUpdate.push({
          urlKey: key,
          browserId: b.id,
          title: t.title,
          tagNames: t.tagNames,
          // Contract: the `categoryPath` key is present ONLY when the browser
          // folder must change. Its value is always an array — `[]` means
          // "move to the managed root" (cloud cleared the category); absence
          // of the key means "leave the folder untouched" (title/tags-only
          // update, or bookmark outside the managed subtree).
          ...(tCategoryApplies ? { categoryPath: t.categoryPath ?? [] } : {}),
        });
      } else {
        const titleConflict = bTitleChanged && tTitleChanged && b.title !== t.title;
        const tagsConflict = bTagsChanged && tTagsChanged && tagsDiffer(b.tagNames, t.tagNames);
        // A conflict needs a positive cloud suggestion to weigh against the
        // local move; a cloud *clear* (null) is a weak signal — the local
        // manual move just wins silently (D5) without a review badge.
        const categoryConflict =
          bCategoryChanged &&
          tCategoryChanged &&
          t.categoryPath !== null &&
          !pathsEqual(b.folderPath, t.categoryPath);
        if (titleConflict || tagsConflict || categoryConflict) {
          conflicts.push({
            urlKey: key,
            reason: categoryConflict && !titleConflict && !tagsConflict ? 'category_conflict' : 'both_modified',
            fields: { title: titleConflict, tags: tagsConflict, category: categoryConflict },
            ...(categoryConflict
              ? { localPath: b.folderPath, cloudPath: t.categoryPath }
              : {}),
          });
          // Browser version already pushed; do not auto-clobber it with TN's.
          // C4-4/D5: the local manual move wins upward; the cloud suggestion
          // is surfaced for review, never force-applied.
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

// tests/sync-engine.test.ts
//
// Exercises the pure two-way sync planner (planSync / computeWatermark): the
// three-way merge against the last-synced snapshot, field-level last-write-wins,
// upload vs two-way direction behaviour, conflict detection, and cross-language
// urlKey parity (the browser side uses the JS port of the backend's urlKey).

import { describe, it, expect } from 'vitest';
import { planSync, computeWatermark } from '../extension/bg/sync-engine';
import { urlKey } from '../extension/bg/sync-diff';

const TN = (
  urlKey: string,
  title: string,
  updatedAt: string,
  deletedAt: string | null = null,
  categoryPath: string[] | null = null,
) => ({
  id: `t-${urlKey}`,
  urlKey,
  url: `https://${urlKey}`,
  title,
  tagNames: [],
  updatedAt,
  deletedAt,
  categoryPath,
});

const BR = (
  id: string,
  url: string,
  title: string,
  tagNames: string[] = [],
  folderPath: string[] | null = null,
) => ({
  id,
  url,
  title,
  tagNames,
  folderPath,
});

describe('planSync — upload direction (browser → TagNest only)', () => {
  it('pushes a brand-new local bookmark', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A')],
      tnPullItems: [],
      direction: 'upload',
    });
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.toPush.upserts[0].url).toBe('https://a.com/x');
    expect(plan.toApply.toCreate).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('pushes a locally edited bookmark (changed vs snapshot)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'New')],
      tnPullItems: [TN('a.com/x', 'Old', '2024-01-01')],
      lastSnapshot: { 'a.com/x': { title: 'Old' } },
      direction: 'upload',
    });
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.toPush.upserts[0].title).toBe('New');
  });

  it('pushes a delete when the browser removed a synced bookmark', () => {
    const plan = planSync({
      browserBookmarks: [],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01')],
      lastSnapshot: { 'a.com/x': { title: 'A' } },
      direction: 'upload',
    });
    expect(plan.toPush.deletes).toHaveLength(1);
    expect(plan.toPush.deletes[0].urlKey).toBe('a.com/x');
  });

  it('ignores TagNest-only bookmarks (no write-back in upload mode)', () => {
    const plan = planSync({
      browserBookmarks: [],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01')],
      direction: 'upload',
    });
    expect(plan.toPush.upserts).toHaveLength(0);
    expect(plan.toPush.deletes).toHaveLength(0);
    expect(plan.toApply.toCreate).toHaveLength(0);
  });

  it('never raises conflicts in upload mode (browser is authoritative)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'Browser')],
      tnPullItems: [TN('a.com/x', 'TNv', '2024-06-01')],
      lastSnapshot: { 'a.com/x': { title: 'Base' } },
      direction: 'upload',
    });
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.toPush.upserts).toHaveLength(1);
  });
});

describe('planSync — two-way direction (browser ↔ TagNest)', () => {
  it('creates a browser bookmark for a TagNest-only entry', () => {
    const plan = planSync({
      browserBookmarks: [],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01')],
      direction: 'two-way',
    });
    expect(plan.toApply.toCreate).toHaveLength(1);
    expect(plan.toApply.toCreate[0].urlKey).toBe('a.com/x');
  });

  it('removes a browser bookmark when TagNest soft-deleted it (unchanged locally)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A')],
      tnPullItems: [TN('a.com/x', 'A', '2024-06-01', '2024-06-01')],
      lastSnapshot: { 'a.com/x': { title: 'A' } },
      direction: 'two-way',
    });
    expect(plan.toApply.toRemove).toHaveLength(1);
    expect(plan.toApply.toRemove[0].browserId).toBe('b1');
    expect(plan.conflicts).toHaveLength(0);
  });

  it('applies a TagNest-only change when the browser is unchanged', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'Base')],
      tnPullItems: [TN('a.com/x', 'TNv', '2024-06-01')],
      lastSnapshot: { 'a.com/x': { title: 'Base' } },
      direction: 'two-way',
    });
    expect(plan.toApply.toUpdate).toHaveLength(1);
    expect(plan.toApply.toUpdate[0].title).toBe('TNv');
    expect(plan.toPush.upserts).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('flags a hard conflict when both sides changed the same title', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'Browser')],
      tnPullItems: [TN('a.com/x', 'TNv', '2024-06-01')],
      lastSnapshot: { 'a.com/x': { title: 'Base' } },
      direction: 'two-way',
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ urlKey: 'a.com/x', reason: 'both_modified', fields: { title: true } });
    // Browser version is pushed (wins); TN is NOT auto-applied to avoid clobbering.
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.toApply.toUpdate).toHaveLength(0);
  });

  it('propagates a local edit that wins over a TagNest deletion', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'Edited')],
      tnPullItems: [TN('a.com/x', 'Edited', '2024-06-01', '2024-06-01')],
      lastSnapshot: { 'a.com/x': { title: 'Old' } },
      direction: 'two-way',
    });
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(1);
  });

  it('treats a key present on both sides with no base as already-synced (no churn)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A')],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01')],
      direction: 'two-way',
    });
    expect(plan.toPush.upserts).toHaveLength(0);
    expect(plan.toApply.toCreate).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });
});

describe('planSync — category dimension (C4-4 folder-aware)', () => {
  it('pushes a local folder move upward (managed subtree)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], ['开发技术', '前端'])],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01', null, ['开发技术'])],
      lastSnapshot: { 'a.com/x': { title: 'A', categoryPath: ['开发技术'] } },
      direction: 'upload',
    });
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.toPush.upserts[0].folderPath).toEqual(['开发技术', '前端']);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('does NOT push when the bookmark sits outside the managed subtree (folderPath null)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], null)],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01', null, ['开发技术'])],
      lastSnapshot: { 'a.com/x': { title: 'A', categoryPath: ['开发技术'] } },
      direction: 'upload',
    });
    expect(plan.toPush.upserts).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('does NOT push when parked at the managed root (empty folderPath)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], [])],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01', null, ['开发技术'])],
      lastSnapshot: { 'a.com/x': { title: 'A', categoryPath: ['开发技术'] } },
      direction: 'upload',
    });
    expect(plan.toPush.upserts).toHaveLength(0);
  });

  it('applies a cloud category change to a managed, locally-unchanged bookmark', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], ['旧分类'])],
      tnPullItems: [TN('a.com/x', 'A', '2024-06-01', null, ['新分类'])],
      lastSnapshot: { 'a.com/x': { title: 'A', categoryPath: ['旧分类'] } },
      direction: 'two-way',
    });
    expect(plan.toApply.toUpdate).toHaveLength(1);
    expect(plan.toApply.toUpdate[0].categoryPath).toEqual(['新分类']);
    expect(plan.toPush.upserts).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('maps a cloud category clear to a move to the managed root ([])', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], ['旧分类'])],
      tnPullItems: [TN('a.com/x', 'A', '2024-06-01', null, null)],
      lastSnapshot: { 'a.com/x': { title: 'A', categoryPath: ['旧分类'] } },
      direction: 'two-way',
    });
    expect(plan.toApply.toUpdate).toHaveLength(1);
    expect(plan.toApply.toUpdate[0].categoryPath).toEqual([]);
  });

  it('omits categoryPath on a title/tags-only update (folder untouched)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'Old', [], ['分类'])],
      tnPullItems: [TN('a.com/x', 'New', '2024-06-01', null, ['分类'])],
      lastSnapshot: { 'a.com/x': { title: 'Old', categoryPath: ['分类'] } },
      direction: 'two-way',
    });
    expect(plan.toApply.toUpdate).toHaveLength(1);
    expect(plan.toApply.toUpdate[0]).not.toHaveProperty('categoryPath');
  });

  it('does NOT drag an unmanaged bookmark into the managed folder on cloud re-categorise', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], null)],
      tnPullItems: [TN('a.com/x', 'A', '2024-06-01', null, ['新分类'])],
      lastSnapshot: { 'a.com/x': { title: 'A', categoryPath: null } },
      direction: 'two-way',
    });
    expect(plan.toApply.toUpdate).toHaveLength(0);
    expect(plan.toPush.upserts).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('flags category_conflict when both sides re-categorised differently (local wins upward)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], ['本地分类'])],
      tnPullItems: [TN('a.com/x', 'A', '2024-06-01', null, ['云端分类'])],
      lastSnapshot: { 'a.com/x': { title: 'A', categoryPath: ['基线'] } },
      direction: 'two-way',
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      urlKey: 'a.com/x',
      reason: 'category_conflict',
      fields: { category: true, title: false, tags: false },
      localPath: ['本地分类'],
      cloudPath: ['云端分类'],
    });
    // Local manual move is pushed (D5); cloud suggestion is NOT auto-applied.
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.toApply.toUpdate).toHaveLength(0);
  });

  it('uses both_modified when category and title conflict together', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'B标题', [], ['本地分类'])],
      tnPullItems: [TN('a.com/x', 'T标题', '2024-06-01', null, ['云端分类'])],
      lastSnapshot: { 'a.com/x': { title: '基线', categoryPath: ['基线分类'] } },
      direction: 'two-way',
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].reason).toBe('both_modified');
    expect(plan.conflicts[0].fields).toMatchObject({ title: true, category: true });
  });

  it('lets a local move win silently when the cloud only cleared its category', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], ['本地分类'])],
      tnPullItems: [TN('a.com/x', 'A', '2024-06-01', null, null)],
      lastSnapshot: { 'a.com/x': { title: 'A', categoryPath: ['基线'] } },
      direction: 'two-way',
    });
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0); // no positive cloud suggestion → no badge
    expect(plan.toApply.toUpdate).toHaveLength(0);
  });

  it('carries categoryPath on a TagNest-only create (two-way)', () => {
    const plan = planSync({
      browserBookmarks: [],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01', null, ['开发技术'])],
      direction: 'two-way',
    });
    expect(plan.toApply.toCreate).toHaveLength(1);
    expect(plan.toApply.toCreate[0].categoryPath).toEqual(['开发技术']);
  });

  it('treats equal categories on a first sync (no base) as converged', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], ['开发技术'])],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01', null, ['开发技术'])],
      direction: 'two-way',
    });
    expect(plan.toPush.upserts).toHaveLength(0);
    expect(plan.toApply.toUpdate).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('resolves a first-sync category divergence as a conflict with local precedence', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], ['本地'])],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01', null, ['云端'])],
      direction: 'two-way',
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].reason).toBe('category_conflict');
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.toApply.toUpdate).toHaveLength(0);
  });

  it('pushes local folder placement when the cloud never categorised (first sync)', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], ['本地'])],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01', null, null)],
      direction: 'two-way',
    });
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('keeps a local category move winning over a TagNest deletion', () => {
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://a.com/x', 'A', [], ['新分类'])],
      tnPullItems: [TN('a.com/x', 'A', '2024-06-01', '2024-06-01', ['旧分类'])],
      lastSnapshot: { 'a.com/x': { title: 'A', categoryPath: ['旧分类'] } },
      direction: 'two-way',
    });
    expect(plan.toPush.upserts).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].reason).toBe('deleted_in_tagnest_but_modified_locally');
  });
});

describe('computeWatermark', () => {
  it('returns the max updatedAt among pulled items, honouring lastSyncedAt', () => {
    expect(
      computeWatermark(
        [TN('a.com/1', 'A', '2024-03-01'), TN('a.com/2', 'B', '2024-05-01')],
        '2024-01-01',
      ),
    ).toBe('2024-05-01');
  });

  it('falls back to lastSyncedAt when nothing was pulled', () => {
    expect(computeWatermark([], '2024-04-04')).toBe('2024-04-04');
  });
});

describe('cross-language urlKey parity', () => {
  it('normalises tracking params and www the same way the backend does', () => {
    // Must equal the url_key the backend computes for the same URL.
    expect(urlKey('https://www.A.com/x?utm_source=foo#sec')).toBe('a.com/x');
    const plan = planSync({
      browserBookmarks: [BR('b1', 'https://www.A.com/x?utm_source=foo#sec', 'A')],
      tnPullItems: [TN('a.com/x', 'A', '2024-01-01')],
      direction: 'upload',
    });
    // Browser and TN keys match → no spurious push on a tracking-param variant.
    expect(plan.toPush.upserts).toHaveLength(0);
  });
});

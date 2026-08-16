// tests/sync-engine.test.ts
//
// Exercises the pure two-way sync planner (planSync / computeWatermark): the
// three-way merge against the last-synced snapshot, field-level last-write-wins,
// upload vs two-way direction behaviour, conflict detection, and cross-language
// urlKey parity (the browser side uses the JS port of the backend's urlKey).

import { describe, it, expect } from 'vitest';
import { planSync, computeWatermark } from '../extension/bg/sync-engine';
import { urlKey } from '../extension/bg/sync-diff';

const TN = (urlKey: string, title: string, updatedAt: string, deletedAt: string | null = null) => ({
  id: `t-${urlKey}`,
  urlKey,
  url: `https://${urlKey}`,
  title,
  tagNames: [],
  updatedAt,
  deletedAt,
});

const BR = (id: string, url: string, title: string, tagNames: string[] = []) => ({
  id,
  url,
  title,
  tagNames,
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

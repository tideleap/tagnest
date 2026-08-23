// tests/sync-push.test.ts
//
// Exercises POST /api/bookmarks/sync-push against the in-memory D1 mock:
// upsert(create/update/revive), soft-delete, per-change error reporting,
// last-write-wins gating, and tag reconciliation.

import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestPost as pushChanges } from '../functions/api/bookmarks/sync-push';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';
const OTHER = 'u2';

function seedBm(
  db: MockDb,
  id: string,
  user: string,
  urlKey: string,
  title: string,
  updatedAt: string,
  extra: Record<string, unknown> = {},
) {
  db.bookmarks.push({
    id,
    user_id: user,
    url: `https://${urlKey}`,
    url_key: urlKey,
    title,
    updated_at: updatedAt,
    deleted_at: null,
    is_private: 0,
    is_favorite: 0,
    is_archived: 0,
    ...extra,
  });
}

function postCtx(env: Env, userId: string, changes: unknown) {
  return {
    request: new Request('https://tagnest.test/api/bookmarks/sync-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes }),
    }),
    env,
    data: { userId },
    params: {},
  } as any;
}

let env: Env;
let db: MockDb;

beforeEach(() => {
  env = makeEnv();
  db = env.DB as MockDb;
});

describe('POST /api/bookmarks/sync-push', () => {
  it('inserts a new bookmark on upsert', async () => {
    const res = await pushChanges(postCtx(env, USER, [{ op: 'upsert', url: 'https://a.com/x', title: 'A' }]));
    const body = await res.json();
    expect(body.applied).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.errors).toEqual([]);

    const row = db.bookmarks.find((b) => b.url === 'https://a.com/x');
    expect(row).toBeTruthy();
    expect(row!.title).toBe('A');
    expect(row!.deleted_at).toBeNull();
    expect(row!.user_id).toBe(USER);
  });

  it('updates fields of an existing live bookmark on upsert', async () => {
    seedBm(db, 'b1', USER, 'a.com/x', 'Old', '2024-01-01T00:00:00Z');
    const res = await pushChanges(postCtx(env, USER, [{ op: 'upsert', url: 'https://a.com/x', title: 'New' }]));
    const body = await res.json();
    expect(body.applied).toBe(1);
    const row = db.bookmarks.find((b) => b.id === 'b1')!;
    expect(row.title).toBe('New');
    expect(db.bookmarks.filter((b) => b.url_key === 'a.com/x')).toHaveLength(1);
  });

  it('revives a soft-deleted bookmark on upsert (re-surfaced by the spoke)', async () => {
    seedBm(db, 'b1', USER, 'a.com/x', 'Gone', '2024-02-01T00:00:00Z', {
      deleted_at: '2024-02-01T00:00:00Z',
    });
    const res = await pushChanges(postCtx(env, USER, [{ op: 'upsert', url: 'https://a.com/x', title: 'Back' }]));
    const body = await res.json();
    expect(body.applied).toBe(1);
    const row = db.bookmarks.find((b) => b.id === 'b1')!;
    expect(row.deleted_at).toBeNull();
    expect(row.title).toBe('Back');
  });

  it('soft-deletes the matching live row on delete (never hard purge)', async () => {
    seedBm(db, 'b1', USER, 'a.com/x', 'A', '2024-01-01T00:00:00Z');
    const res = await pushChanges(postCtx(env, USER, [{ op: 'delete', url: 'https://a.com/x' }]));
    const body = await res.json();
    expect(body.applied).toBe(1);
    const row = db.bookmarks.find((b) => b.id === 'b1')!;
    expect(row.deleted_at).not.toBeNull();
    // Hard row still present (soft delete).
    expect(db.bookmarks.filter((b) => b.url_key === 'a.com/x')).toHaveLength(1);
  });

  it('treats deleting an absent bookmark as a no-op success', async () => {
    const res = await pushChanges(postCtx(env, USER, [{ op: 'delete', url: 'https://a.com/ghost' }]));
    const body = await res.json();
    expect(body.applied).toBe(1);
    expect(body.failed).toBe(0);
  });

  it('reports per-change errors for invalid op and invalid url without aborting the batch', async () => {
    const res = await pushChanges(
      postCtx(env, USER, [
        { op: 'frob', url: 'https://a.com/x' },
        { op: 'upsert', url: 'not a real url' },
        { op: 'upsert', url: 'https://a.com/ok', title: 'Ok' },
      ]),
    );
    const body = await res.json();
    expect(body.applied).toBe(1);
    expect(body.failed).toBe(2);
    expect(body.errors.map((e: any) => e.code).sort()).toEqual(['invalid_op', 'invalid_url']);
    expect(body.errors.map((e: any) => e.index).sort()).toEqual([0, 1]);
  });

  it('keeps the server row when the change is older (last-write-wins)', async () => {
    seedBm(db, 'b1', USER, 'a.com/x', 'Newer', '2024-06-01T00:00:00Z');
    const res = await pushChanges(
      postCtx(env, USER, [{ op: 'upsert', url: 'https://a.com/x', title: 'Stale', updatedAt: '2024-01-01T00:00:00Z' }]),
    );
    const body = await res.json();
    expect(body.applied).toBe(1);
    const row = db.bookmarks.find((b) => b.id === 'b1')!;
    expect(row.title).toBe('Newer'); // unchanged — server is newer
    expect(row.updated_at > '2024-06-01T00:00:00Z').toBe(true); // touch still recorded
  });

  it('reconciles tag names on upsert', async () => {
    const res = await pushChanges(
      postCtx(env, USER, [{ op: 'upsert', url: 'https://a.com/x', title: 'A', tagNames: ['rust', 'Rust'] }]),
    );
    const body = await res.json();
    expect(body.applied).toBe(1);

    const row = db.bookmarks.find((b) => b.url === 'https://a.com/x')!;
    // Case-insensitive dedupe → a single tag.
    const rustTag = db.tags.find((t) => t.user_id === USER && String(t.name).toLowerCase() === 'rust');
    expect(rustTag).toBeTruthy();
    expect(db.bookmark_tags.filter((bt) => bt.bookmark_id === row.id && bt.tag_id === rustTag!.id)).toHaveLength(1);
  });

  it('scopes upserts per user (no cross-account collision)', async () => {
    seedBm(db, 'mine', USER, 'a.com/x', 'Mine', '2024-01-01T00:00:00Z');
    const res = await pushChanges(postCtx(env, OTHER, [{ op: 'upsert', url: 'https://a.com/x', title: 'Theirs' }]));
    const body = await res.json();
    expect(body.applied).toBe(1);
    // Two distinct rows for the same url_key, one per user.
    expect(db.bookmarks.filter((b) => b.url_key === 'a.com/x')).toHaveLength(2);
    expect(db.bookmarks.find((b) => b.id === 'mine')!.title).toBe('Mine');
  });

  it('rejects a non-array changes payload', async () => {
    await expect(pushChanges(postCtx(env, USER, { changes: 'nope' } as any))).rejects.toThrow(
      'changes 必须是数组',
    );
  });
});

describe('POST /api/bookmarks/sync-push — categoryPath (C4-3)', () => {
  it('creates the folder chain and writes a browser_folder placement', async () => {
    const res = await pushChanges(
      postCtx(env, USER, [
        { op: 'upsert', url: 'https://a.com/x', title: 'A', categoryPath: ['开发技术', '前端开发'] },
      ]),
    );
    const body = await res.json();
    expect(body.applied).toBe(1);
    expect(body.failed).toBe(0);

    // Both folder levels materialised as a parent_id chain.
    const root = db.tags.find((t) => t.user_id === USER && t.name === '开发技术');
    const leaf = db.tags.find((t) => t.user_id === USER && t.name === '前端开发');
    expect(root).toBeTruthy();
    expect(leaf).toBeTruthy();
    expect(root!.parent_id ?? null).toBeNull();
    expect(leaf!.parent_id).toBe(root!.id);

    // The bookmark's single placement points at the leaf, source=browser_folder.
    const bm = db.bookmarks.find((b) => b.url === 'https://a.com/x')!;
    const placement = db.bookmark_primary_category.find((p) => p.bookmark_id === bm.id);
    expect(placement).toBeTruthy();
    expect(placement!.tag_id).toBe(leaf!.id);
    expect(placement!.source).toBe('browser_folder');
    expect(placement!.status).toBe('accepted');
  });

  it('reuses an existing folder path case-insensitively instead of duplicating', async () => {
    db.tags.push({
      id: 't_root', user_id: USER, name: '开发技术', color_index: 0,
      parent_id: null, sort_order: 0, is_private: 0, created_at: '2024-01-01T00:00:00Z',
    });
    const res = await pushChanges(
      postCtx(env, USER, [
        { op: 'upsert', url: 'https://a.com/x', title: 'A', categoryPath: ['开发技术'] },
      ]),
    );
    expect((await res.json()).applied).toBe(1);
    // No duplicate root created.
    expect(db.tags.filter((t) => t.user_id === USER && String(t.name).toLowerCase() === '开发技术')).toHaveLength(1);
    const bm = db.bookmarks.find((b) => b.url === 'https://a.com/x')!;
    expect(db.bookmark_primary_category.find((p) => p.bookmark_id === bm.id)!.tag_id).toBe('t_root');
  });

  it('bumps updated_at so the placement reaches other browsers (C5-2)', async () => {
    seedBm(db, 'b1', USER, 'a.com/x', 'A', '2024-01-01T00:00:00Z');
    await pushChanges(
      postCtx(env, USER, [
        { op: 'upsert', url: 'https://a.com/x', title: 'A', categoryPath: ['工作'] },
      ]),
    );
    const row = db.bookmarks.find((b) => b.id === 'b1')!;
    expect(row.updated_at > '2024-01-01T00:00:00Z').toBe(true);
  });

  it('records a modified feedback event keyed by the full path', async () => {
    await pushChanges(
      postCtx(env, USER, [
        { op: 'upsert', url: 'https://a.com/x', title: 'A', categoryPath: ['开发技术', '前端开发'] },
      ]),
    );
    expect(db.ai_feedback).toHaveLength(1);
    const fb = db.ai_feedback[0];
    expect(fb.action).toBe('modified');
    expect(fb.source).toBe('browser_folder');
    expect(fb.tag_name).toBe('开发技术 > 前端开发');
    expect(fb.domain).toBe('a.com');
  });

  it('overwrites a prior placement when the folder moves', async () => {
    await pushChanges(
      postCtx(env, USER, [
        { op: 'upsert', url: 'https://a.com/x', title: 'A', categoryPath: ['旧分类'] },
      ]),
    );
    await pushChanges(
      postCtx(env, USER, [
        { op: 'upsert', url: 'https://a.com/x', title: 'A', categoryPath: ['新分类'] },
      ]),
    );
    const bm = db.bookmarks.find((b) => b.url === 'https://a.com/x')!;
    const placements = db.bookmark_primary_category.filter((p) => p.bookmark_id === bm.id);
    // Still exactly one placement — the move replaced it in place.
    expect(placements).toHaveLength(1);
    const newLeaf = db.tags.find((t) => t.user_id === USER && t.name === '新分类');
    expect(placements[0].tag_id).toBe(newLeaf!.id);
  });

  it('leaves placement untouched when categoryPath is absent or null', async () => {
    await pushChanges(postCtx(env, USER, [{ op: 'upsert', url: 'https://a.com/x', title: 'A' }]));
    await pushChanges(postCtx(env, USER, [{ op: 'upsert', url: 'https://a.com/x', title: 'A', categoryPath: null }]));
    expect(db.bookmark_primary_category).toHaveLength(0);
  });

  it('rejects an over-deep categoryPath without aborting other changes', async () => {
    const deep = Array.from({ length: 9 }, (_, i) => `L${i}`);
    const res = await pushChanges(
      postCtx(env, USER, [
        { op: 'upsert', url: 'https://a.com/deep', title: 'D', categoryPath: deep },
        { op: 'upsert', url: 'https://a.com/ok', title: 'Ok' },
      ]),
    );
    const body = await res.json();
    expect(body.applied).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.errors[0].code).toBe('invalid_category_path');
    expect(body.errors[0].index).toBe(0);
  });

  it('rejects a categoryPath with empty or non-string segments', async () => {
    const res = await pushChanges(
      postCtx(env, USER, [
        { op: 'upsert', url: 'https://a.com/x', title: 'A', categoryPath: ['ok', '  '] },
      ]),
    );
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(body.errors[0].code).toBe('invalid_category_path');
    expect(db.bookmark_primary_category).toHaveLength(0);
  });
});

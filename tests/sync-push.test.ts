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

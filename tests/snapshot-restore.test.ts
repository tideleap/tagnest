/**
 * Contract tests for the time-machine restore endpoint (B-2 / O2).
 *
 * POST /api/bookmarks/:id/snapshots/restore promotes a retained historical
 * snapshot to be the bookmark's current preview. It is a pure pointer swap on
 * `snapshot_key` — idempotent, lossless, and it rejects keys that are not in
 * the retained list (already pruned or fabricated).
 */
import { describe, it, expect } from 'vitest';
import { onRequestPost as restoreSnapshot } from '../functions/api/bookmarks/[id]/snapshots/restore';
import { loadSnapshotState } from '../functions/_lib/db';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u-tm';

function seedBookmark(
  db: MockDb,
  id: string,
  over: Record<string, unknown> = {},
) {
  db.bookmarks.push({
    id,
    user_id: USER,
    url: `https://example.com/${id}`,
    url_key: `https://example.com/${id}`,
    title: `Bookmark ${id}`,
    favicon_url: null,
    description: null,
    note: null,
    cover_url: null,
    snapshot_key: null,
    snapshot_keys: null,
    is_favorite: 0,
    is_archived: 0,
    is_private: 0,
    encrypted_blob: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  });
}

function makeCtx(env: any, userId: string, id: string, body?: unknown) {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request(`https://tagnest.test/api/bookmarks/${id}/snapshots/restore`, init),
    env,
    data: { userId },
    params: { id },
  } as any;
}

const K_OLD = 'snapshots/u-tm/b1-1000.webp';
const K_MID = 'snapshots/u-tm/b1-2000.webp';
const K_NEW = 'snapshots/u-tm/b1-3000.webp';

describe('POST /api/bookmarks/:id/snapshots/restore', () => {
  it('promotes a retained historical version to current', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', { snapshot_key: K_NEW, snapshot_keys: JSON.stringify([K_OLD, K_MID, K_NEW]) });
    const env = makeEnv({ DB: db });

    const res = await restoreSnapshot(makeCtx(env, USER, 'b1', { key: K_OLD }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshotKey: string; url: string };
    expect(body.snapshotKey).toBe(K_OLD);
    expect(body.url).toContain('/api/snapshots/');

    // The DB pointer moved; the retained list is untouched.
    const state = await loadSnapshotState(env, USER, 'b1');
    expect(state?.snapshotKey).toBe(K_OLD);
    expect(state?.snapshotKeys).toEqual([K_OLD, K_MID, K_NEW]);
  });

  it('is idempotent when restoring the already-current version', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', { snapshot_key: K_NEW, snapshot_keys: JSON.stringify([K_OLD, K_NEW]) });
    const env = makeEnv({ DB: db });

    const res = await restoreSnapshot(makeCtx(env, USER, 'b1', { key: K_NEW }));
    expect(res.status).toBe(200);
    const state = await loadSnapshotState(env, USER, 'b1');
    expect(state?.snapshotKey).toBe(K_NEW);
  });

  it('rejects a key that is not in the retained list', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', { snapshot_key: K_NEW, snapshot_keys: JSON.stringify([K_NEW]) });
    const env = makeEnv({ DB: db });

    await expect(
      restoreSnapshot(makeCtx(env, USER, 'b1', { key: 'snapshots/u-tm/b1-9999.webp' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a missing key', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', { snapshot_key: K_NEW, snapshot_keys: JSON.stringify([K_NEW]) });
    const env = makeEnv({ DB: db });

    await expect(
      restoreSnapshot(makeCtx(env, USER, 'b1', {})),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('returns 404 for a bookmark the user does not own', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', { snapshot_key: K_NEW, snapshot_keys: JSON.stringify([K_NEW]) });
    const env = makeEnv({ DB: db });

    await expect(
      restoreSnapshot(makeCtx(env, 'u-other', 'b1', { key: K_NEW })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('returns 404 for a private bookmark (privacy gate)', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', {
      snapshot_key: K_NEW,
      snapshot_keys: JSON.stringify([K_NEW]),
      is_private: 1,
    });
    const env = makeEnv({ DB: db });

    await expect(
      restoreSnapshot(makeCtx(env, USER, 'b1', { key: K_NEW })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('returns 404 for a deleted bookmark', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', {
      snapshot_key: K_NEW,
      snapshot_keys: JSON.stringify([K_NEW]),
      deleted_at: '2026-01-02T00:00:00Z',
    });
    const env = makeEnv({ DB: db });

    await expect(
      restoreSnapshot(makeCtx(env, USER, 'b1', { key: K_NEW })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

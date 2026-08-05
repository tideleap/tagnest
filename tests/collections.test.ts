import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as listCollections } from '../functions/api/collections/index';
import { onRequestPost as createCollection } from '../functions/api/collections/index';
import {
  onRequestGet as getCollection,
  onRequestPut as renameCollection,
  onRequestDelete as deleteCollection,
} from '../functions/api/collections/[id]';
import {
  onRequestPost as addBookmark,
  onRequestDelete as removeBookmark,
} from '../functions/api/collections/[id]/bookmarks';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';

function makeCtx(
  env: Env,
  userId: string,
  method: string,
  path: string,
  id?: string,
  body?: unknown,
) {
  const url = `https://tagnest.test${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request(url, init),
    env,
    data: { userId },
    params: id ? { id } : {},
  } as any;
}

function seedCollection(db: MockDb, over: Record<string, unknown> = {}) {
  db.collections.push({
    id: 'c1',
    user_id: USER,
    name: '阅读清单',
    color_index: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  });
}

function seedBookmark(
  db: MockDb,
  over: Record<string, unknown> = {},
) {
  db.bookmarks.push({
    id: 'b1',
    user_id: USER,
    url: 'https://example.com/a',
    title: 'Article A',
    favicon_url: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  });
}

describe('GET /api/collections', () => {
  it('returns an empty list for a fresh account', async () => {
    const env = makeEnv();
    const res = await listCollections(makeCtx(env, USER, 'GET', '/api/collections'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('lists the user’s collections ordered by name (case-insensitive)', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedCollection(db, { id: 'c-z', name: 'Zebra' });
    seedCollection(db, { id: 'c-a', name: 'apple' });
    seedCollection(db, { id: 'c-m', name: 'Mango' });

    const res = await listCollections(makeCtx(env, USER, 'GET', '/api/collections'));
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(['apple', 'Mango', 'Zebra']);
  });

  it('does not leak another user’s collections', async () => {
    const env = makeEnv();
    seedCollection(env.DB as MockDb, { id: 'c-other', user_id: 'other' });
    const res = await listCollections(makeCtx(env, USER, 'GET', '/api/collections'));
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });
});

describe('POST /api/collections', () => {
  it('creates a collection and returns 201', async () => {
    const env = makeEnv();
    const res = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, { name: '  设计参考  ' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; colorIndex: number; count: number };
    expect(body.name).toBe('设计参考'); // trimmed + collapsed whitespace
    expect(body.count).toBe(0);
    expect(Number.isInteger(body.colorIndex)).toBe(true);
    expect((env.DB as MockDb).collections).toHaveLength(1);
  });

  it('rejects an empty name with 400', async () => {
    const env = makeEnv();
    await expect(
      createCollection(makeCtx(env, USER, 'POST', '/api/collections', undefined, { name: '   ' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a duplicate name with 409', async () => {
    const env = makeEnv();
    seedCollection(env.DB as MockDb, { name: '阅读清单' });
    await expect(
      createCollection(
        makeCtx(env, USER, 'POST', '/api/collections', undefined, { name: '阅读清单' }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('GET /api/collections/:id', () => {
  it('returns the collection with its bookmarks, ordered by position', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedCollection(db);
    seedBookmark(db, { id: 'b1', title: 'A', created_at: '2026-01-01T00:00:00Z' });
    seedBookmark(db, { id: 'b2', title: 'B', created_at: '2026-02-01T00:00:00Z' });
    db.collection_bookmarks.push({ collection_id: 'c1', bookmark_id: 'b1', position: 1, created_at: 't' });
    db.collection_bookmarks.push({ collection_id: 'c1', bookmark_id: 'b2', position: 0, created_at: 't' });

    const res = await getCollection(makeCtx(env, USER, 'GET', `/api/collections/c1`, 'c1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collection: { id: string; count: number };
      bookmarks: Array<{ id: string }>;
    };
    expect(body.collection.id).toBe('c1');
    expect(body.collection.count).toBe(2);
    // position 0 (b2) ranks before position 1 (b1).
    expect(body.bookmarks.map((b) => b.id)).toEqual(['b2', 'b1']);
  });

  it('returns 404 for an unknown collection', async () => {
    const env = makeEnv();
    await expect(
      getCollection(makeCtx(env, USER, 'GET', '/api/collections/nope', 'nope')),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('returns 404 when the collection belongs to another user', async () => {
    const env = makeEnv();
    seedCollection(env.DB as MockDb, { id: 'c-other', user_id: 'other' });
    await expect(
      getCollection(makeCtx(env, USER, 'GET', '/api/collections/c-other', 'c-other')),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('PUT /api/collections/:id', () => {
  it('renames and recolors the collection', async () => {
    const env = makeEnv();
    seedCollection(env.DB as MockDb);
    const res = await renameCollection(
      makeCtx(env, USER, 'PUT', '/api/collections/c1', 'c1', { name: '新名字', colorIndex: 5 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; colorIndex: number };
    expect(body.name).toBe('新名字');
    expect(body.colorIndex).toBe(5);
  });

  it('rejects a duplicate name with 409', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedCollection(db, { id: 'c1', name: 'A' });
    seedCollection(db, { id: 'c2', name: 'B' });
    await expect(
      renameCollection(makeCtx(env, USER, 'PUT', '/api/collections/c2', 'c2', { name: 'A' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('returns 404 for an unknown collection', async () => {
    const env = makeEnv();
    await expect(
      renameCollection(makeCtx(env, USER, 'PUT', '/api/collections/nope', 'nope', { name: 'x' })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('DELETE /api/collections/:id', () => {
  it('cascades: deletes the collection and its membership', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedCollection(db);
    seedBookmark(db);
    db.collection_bookmarks.push({ collection_id: 'c1', bookmark_id: 'b1', position: 0, created_at: 't' });

    const res = await deleteCollection(makeCtx(env, USER, 'DELETE', '/api/collections/c1', 'c1'));
    expect(res.status).toBe(204);
    expect(db.collections).toHaveLength(0);
    expect(db.collection_bookmarks).toHaveLength(0);
  });

  it('returns 404 for an unknown collection', async () => {
    const env = makeEnv();
    await expect(
      deleteCollection(makeCtx(env, USER, 'DELETE', '/api/collections/nope', 'nope')),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('POST /api/collections/:id/bookmarks', () => {
  it('adds a bookmark and appends it at the end of the order', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedCollection(db);
    seedBookmark(db, { id: 'b1' });
    seedBookmark(db, { id: 'b2' });
    db.collection_bookmarks.push({ collection_id: 'c1', bookmark_id: 'b1', position: 0, created_at: 't' });

    const res = await addBookmark(
      makeCtx(env, USER, 'POST', '/api/collections/c1/bookmarks', 'c1', { bookmarkId: 'b2' }),
    );
    expect(res.status).toBe(200);
    expect(db.collection_bookmarks).toHaveLength(2);
    const added = db.collection_bookmarks.find((cb) => cb.bookmark_id === 'b2');
    expect(added?.position).toBe(1); // appended after existing max (0)
  });

  it('is idempotent — adding the same bookmark twice keeps one row', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedCollection(db);
    seedBookmark(db, { id: 'b1' });
    await addBookmark(makeCtx(env, USER, 'POST', '/api/collections/c1/bookmarks', 'c1', { bookmarkId: 'b1' }));
    await addBookmark(makeCtx(env, USER, 'POST', '/api/collections/c1/bookmarks', 'c1', { bookmarkId: 'b1' }));
    expect(db.collection_bookmarks).toHaveLength(1);
  });

  it('returns 404 when the bookmark is trashed or belongs to another user', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedCollection(db);
    seedBookmark(db, { id: 'b-other', user_id: 'other' });
    seedBookmark(db, { id: 'b-trash', deleted_at: '2026-01-01T00:00:00Z' });
    await expect(
      addBookmark(makeCtx(env, USER, 'POST', '/api/collections/c1/bookmarks', 'c1', { bookmarkId: 'b-other' })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      addBookmark(makeCtx(env, USER, 'POST', '/api/collections/c1/bookmarks', 'c1', { bookmarkId: 'b-trash' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('returns 404 for an unknown collection', async () => {
    const env = makeEnv();
    await expect(
      addBookmark(makeCtx(env, USER, 'POST', '/api/collections/nope/bookmarks', 'nope', { bookmarkId: 'b1' })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('DELETE /api/collections/:id/bookmarks', () => {
  it('removes a bookmark from the collection', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedCollection(db);
    seedBookmark(db, { id: 'b1' });
    db.collection_bookmarks.push({ collection_id: 'c1', bookmark_id: 'b1', position: 0, created_at: 't' });

    const res = await removeBookmark(
      makeCtx(env, USER, 'DELETE', '/api/collections/c1/bookmarks?bookmarkId=b1', 'c1'),
    );
    expect(res.status).toBe(204);
    expect(db.collection_bookmarks).toHaveLength(0);
  });

  it('returns 404 for an unknown collection', async () => {
    const env = makeEnv();
    await expect(
      removeBookmark(
        makeCtx(env, USER, 'DELETE', '/api/collections/nope/bookmarks?bookmarkId=b1', 'nope'),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

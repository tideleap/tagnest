import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as listCollections, onRequestPost as createCollection } from '../functions/api/collections/index';
import {
  onRequestGet as getCollection,
  onRequestPut as renameCollection,
} from '../functions/api/collections/[id]';
import { onRequestPost as addBookmark } from '../functions/api/collections/[id]/bookmarks';
import { validateSavedSearchQuery } from '../functions/_lib/collections';
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

function seedBookmark(db: MockDb, over: Record<string, unknown> = {}) {
  db.bookmarks.push({
    id: `b-${db.bookmarks.length + 1}`,
    user_id: USER,
    url: `https://example.com/${db.bookmarks.length + 1}`,
    title: `Bookmark ${db.bookmarks.length + 1}`,
    favicon_url: null,
    deleted_at: null,
    is_favorite: 0,
    is_private: 0,
    is_archived: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  });
}

const FAV_QUERY = {
  q: null,
  tagIds: [] as string[],
  matchAllTags: false,
  scope: 'favorites' as const,
  sort: 'created_desc' as const,
};

describe('validateSavedSearchQuery (pure)', () => {
  it('passes a fully valid query through unchanged', () => {
    const q = validateSavedSearchQuery({
      q: 'react',
      tagIds: ['t1', 't2'],
      matchAllTags: true,
      scope: 'archive',
      sort: 'title_asc',
    });
    expect(q).toEqual({
      q: 'react',
      tagIds: ['t1', 't2'],
      matchAllTags: true,
      scope: 'archive',
      sort: 'title_asc',
    });
  });

  it('clamps out-of-range values to safe defaults', () => {
    const q = validateSavedSearchQuery({
      q: 'x'.repeat(500),
      tagIds: Array.from({ length: 50 }, (_, i) => `t${i}`),
      matchAllTags: 'yes', // non-boolean → coerced
      scope: 'mars', // invalid
      sort: 'sideways', // invalid
    });
    expect(q.q).toBe('x'.repeat(200));
    expect(q.tagIds).toHaveLength(20);
    expect(q.matchAllTags).toBe(true);
    expect(q.scope).toBe('all');
    expect(q.sort).toBe('created_desc');
  });

  it('collapses empty/whitespace q to null', () => {
    expect(validateSavedSearchQuery({ q: '   ' }).q).toBeNull();
    expect(validateSavedSearchQuery({}).q).toBeNull();
  });
});

describe('POST /api/collections (smart)', () => {
  it('creates a smart collection and echoes its query', async () => {
    const env = makeEnv();
    const res = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, {
        name: '我的收藏',
        kind: 'smart',
        query: FAV_QUERY,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      kind: string;
      query: unknown;
      count: number;
    };
    expect(body.kind).toBe('smart');
    expect(body.query).toEqual(FAV_QUERY);
    expect(body.count).toBe(0);
  });

  it('rejects a smart collection without a query (400)', async () => {
    const env = makeEnv();
    await expect(
      createCollection(
        makeCtx(env, USER, 'POST', '/api/collections', undefined, { name: '空智能', kind: 'smart' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('defaults to manual when kind is omitted', async () => {
    const env = makeEnv();
    const res = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, { name: '普通' }),
    );
    const body = (await res.json()) as { kind: string; query: unknown };
    expect(body.kind).toBe('manual');
    expect(body.query).toBeNull();
  });
});

describe('GET /api/collections/:id (smart resolution)', () => {
  it('resolves live members from the query and honors privacy', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    // Create a smart (favorites) collection directly via the endpoint.
    const created = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, {
        name: '收藏夹',
        kind: 'smart',
        query: FAV_QUERY,
      }),
    );
    const { id } = (await created.json()) as { id: string };

    seedBookmark(db, { id: 'b1', is_favorite: 1 });
    seedBookmark(db, { id: 'b2', is_favorite: 1 });
    seedBookmark(db, { id: 'b3', is_favorite: 0 }); // not a favorite
    seedBookmark(db, { id: 'b4', is_favorite: 1, is_private: 1 }); // private → excluded

    const res = await getCollection(makeCtx(env, USER, 'GET', `/api/collections/${id}`, id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collection: { count: number };
      bookmarks: Array<{ id: string }>;
    };
    expect(body.collection.count).toBe(2);
    expect(body.bookmarks.map((b) => b.id).sort()).toEqual(['b1', 'b2']);
  });

  it('is real-time: a newly matching bookmark appears without re-saving', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const created = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, {
        name: '收藏夹',
        kind: 'smart',
        query: FAV_QUERY,
      }),
    );
    const { id } = (await created.json()) as { id: string };
    seedBookmark(db, { id: 'b1', is_favorite: 1 });

    const before = await getCollection(makeCtx(env, USER, 'GET', `/api/collections/${id}`, id));
    expect((await before.json() as any).collection.count).toBe(1);

    seedBookmark(db, { id: 'b-new', is_favorite: 1 });
    const after = await getCollection(makeCtx(env, USER, 'GET', `/api/collections/${id}`, id));
    const afterBody = (await after.json()) as { collection: { count: number }; bookmarks: Array<{ id: string }> };
    expect(afterBody.collection.count).toBe(2);
    expect(afterBody.bookmarks.map((b) => b.id)).toContain('b-new');
  });

  it('returns 404 for another user’s smart collection', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const created = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, {
        name: '别人的',
        kind: 'smart',
        query: FAV_QUERY,
      }),
    );
    const { id } = (await created.json()) as { id: string };
    // Re-seed the row under a different user to simulate cross-tenant.
    const row = db.collections.find((c) => c.id === id)!;
    row.user_id = 'other';
    await expect(
      getCollection(makeCtx(env, USER, 'GET', `/api/collections/${id}`, id)),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('GET /api/collections (smart list count)', () => {
  it('reports a smart collection’s live count, not its (empty) stored membership', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const created = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, {
        name: '收藏夹',
        kind: 'smart',
        query: FAV_QUERY,
      }),
    );
    const { id } = (await created.json()) as { id: string };
    seedBookmark(db, { id: 'b1', is_favorite: 1 });
    seedBookmark(db, { id: 'b2', is_favorite: 1 });

    const res = await listCollections(makeCtx(env, USER, 'GET', '/api/collections'));
    const body = (await res.json()) as { items: Array<{ id: string; kind: string; count: number }> };
    const smart = body.items.find((i) => i.id === id)!;
    expect(smart.kind).toBe('smart');
    expect(smart.count).toBe(2); // live, not 0
  });
});

describe('PUT /api/collections/:id (smart, kind immutable)', () => {
  it('rejects flipping kind from smart to manual (400)', async () => {
    const env = makeEnv();
    const created = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, {
        name: '收藏夹',
        kind: 'smart',
        query: FAV_QUERY,
      }),
    );
    const { id } = (await created.json()) as { id: string };
    await expect(
      renameCollection(makeCtx(env, USER, 'PUT', `/api/collections/${id}`, id, { kind: 'manual' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('allows editing the query and re-resolves members', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const created = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, {
        name: '收藏夹',
        kind: 'smart',
        query: FAV_QUERY, // favorites only
      }),
    );
    const { id } = (await created.json()) as { id: string };
    seedBookmark(db, { id: 'b1', is_favorite: 1 });
    seedBookmark(db, { id: 'b2', is_favorite: 0 });

    // Before edit: only the favorite (b1).
    const before = await getCollection(makeCtx(env, USER, 'GET', `/api/collections/${id}`, id));
    expect((await before.json() as any).collection.count).toBe(1);

    // Widen the query to scope 'all'.
    const put = await renameCollection(
      makeCtx(env, USER, 'PUT', `/api/collections/${id}`, id, {
        query: { ...FAV_QUERY, scope: 'all' },
      }),
    );
    expect(put.status).toBe(200);

    const after = await getCollection(makeCtx(env, USER, 'GET', `/api/collections/${id}`, id));
    expect((await after.json() as any).collection.count).toBe(2); // b1 + b2
  });
});

describe('POST /api/collections/:id/bookmarks (smart rejects manual add)', () => {
  it('returns 409 when adding to a smart collection', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const created = await createCollection(
      makeCtx(env, USER, 'POST', '/api/collections', undefined, {
        name: '收藏夹',
        kind: 'smart',
        query: FAV_QUERY,
      }),
    );
    const { id } = (await created.json()) as { id: string };
    seedBookmark(db, { id: 'b1' });
    await expect(
      addBookmark(makeCtx(env, USER, 'POST', `/api/collections/${id}/bookmarks`, id, { bookmarkId: 'b1' })),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// tests/sync-pull.test.ts
//
// Exercises GET /api/bookmarks/sync-pull against the in-memory D1 mock: the
// lightweight changelog object (url/title/tagNames + deletedAt), soft-delete
// propagation, private/category-private exclusion, per-user scoping, the
// `since` watermark (inclusive), cursor pagination, and the no-store header.

import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as pullChanges } from '../functions/api/bookmarks/sync-pull';
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
    ...extra,
  });
}

function seedTag(db: MockDb, id: string, user: string, name: string) {
  db.tags.push({
    id,
    user_id: user,
    name,
    color_index: 0,
    parent_id: null,
    sort_order: 0,
    is_private: 0,
    created_at: '2024-01-01T00:00:00Z',
  });
}

function linkTag(db: MockDb, bookmarkId: string, tagId: string) {
  db.bookmark_tags.push({ bookmark_id: bookmarkId, tag_id: tagId });
}

function getCtx(env: Env, userId: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return {
    request: new Request(`https://tagnest.test/api/bookmarks/sync-pull${qs ? `?${qs}` : ''}`),
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

describe('GET /api/bookmarks/sync-pull', () => {
  it('returns the lightweight changelog object with tagNames + deletedAt', async () => {
    seedBm(db, 'b1', USER, 'a.com/x', 'Alpha', '2024-01-01T00:00:01Z');
    seedTag(db, 't1', USER, 'rust');
    linkTag(db, 'b1', 't1');

    const res = await pullChanges(getCtx(env, USER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item).toMatchObject({
      id: 'b1',
      urlKey: 'a.com/x',
      url: 'https://a.com/x',
      title: 'Alpha',
      deletedAt: null,
    });
    expect(item.tagNames).toEqual(['rust']);
  });

  it('includes soft-deleted rows so deletions propagate to the browser', async () => {
    seedBm(db, 'live', USER, 'a.com/x', 'A', '2024-01-01T00:00:01Z');
    seedBm(db, 'gone', USER, 'a.com/g', 'G', '2024-02-01T00:00:00Z', { deleted_at: '2024-02-01T00:00:00Z' });

    const body = await (await pullChanges(getCtx(env, USER))).json();
    const ids = body.items.map((i: any) => i.id);
    expect(ids).toContain('live');
    expect(ids).toContain('gone');
    const gone = body.items.find((i: any) => i.id === 'gone');
    expect(gone.deletedAt).not.toBeNull();
  });

  it('excludes private (E2E) and category-private bookmarks', async () => {
    seedBm(db, 'pub', USER, 'a.com/x', 'A', '2024-01-01T00:00:01Z');
    seedBm(db, 'priv', USER, 'a.com/p', 'P', '2024-01-01T00:00:02Z', { is_private: 1 });
    // category-private: tagged with a private tag
    seedBm(db, 'catp', USER, 'a.com/c', 'C', '2024-01-01T00:00:03Z');
    seedTag(db, 'pt1', USER, 'secret');
    db.tags.find((t) => t.id === 'pt1')!.is_private = 1;
    linkTag(db, 'catp', 'pt1');

    const body = await (await pullChanges(getCtx(env, USER))).json();
    expect(body.items.map((i: any) => i.id)).toEqual(['pub']);
  });

  it('scopes results to the requesting user', async () => {
    seedBm(db, 'mine', USER, 'a.com/x', 'A', '2024-01-01T00:00:01Z');
    seedBm(db, 'theirs', OTHER, 'b.com/y', 'B', '2024-01-01T00:00:02Z');

    const body = await (await pullChanges(getCtx(env, USER))).json();
    expect(body.items.map((i: any) => i.id)).toEqual(['mine']);
  });

  it('only returns rows at/after the `since` watermark (inclusive)', async () => {
    // Exactly on the boundary and just after — both must come back.
    seedBm(db, 'before', USER, 'a.com/0', 'Z', '2024-01-01T00:00:00Z');
    seedBm(db, 'on', USER, 'a.com/1', 'A', '2024-01-02T00:00:00Z');
    seedBm(db, 'after', USER, 'a.com/2', 'B', '2024-01-03T00:00:00Z');

    const body = await (await pullChanges(getCtx(env, USER, { since: '2024-01-02T00:00:00Z' }))).json();
    expect(body.items.map((i: any) => i.id).sort()).toEqual(['after', 'on']);
  });

  it('paginates with a stable cursor and covers every changed row', async () => {
    for (let i = 1; i <= 5; i += 1) {
      seedBm(db, `b${i}`, USER, `a.com/${i}`, `B${i}`, `2024-01-0${i}T00:00:00Z`);
    }

    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const res = await pullChanges(getCtx(env, USER, { limit: '2', ...(cursor ? { cursor } : {}) }));
      const body = await res.json();
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((i: any) => i.id));
      cursor = body.cursor;
    } while (cursor);

    expect(seen.sort()).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
  });

  it('sets the no-store cache header (per-account data must not be cached)', async () => {
    seedBm(db, 'b1', USER, 'a.com/x', 'A', '2024-01-01T00:00:01Z');
    const res = await pullChanges(getCtx(env, USER));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

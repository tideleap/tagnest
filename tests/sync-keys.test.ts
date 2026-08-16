// tests/sync-keys.test.ts
//
// Exercises GET /api/bookmarks/sync-keys against the in-memory D1 mock:
// per-user scoping, deleted/private exclusion, cursor pagination, and the
// no-store cache header. The endpoint returns only {id, urlKey, updatedAt,
// title} so the sync client can diff cheaply.

import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as listSyncKeys } from '../functions/api/bookmarks/sync-keys';
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

function getCtx(env: Env, userId: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return {
    request: new Request(`https://tagnest.test/api/bookmarks/sync-keys${qs ? `?${qs}` : ''}`),
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

describe('GET /api/bookmarks/sync-keys', () => {
  it('returns only the requesting user\'s keys', async () => {
    seedBm(db, 'b1', USER, 'a.com/x', 'A', '2024-01-01T00:00:01Z');
    seedBm(db, 'b2', OTHER, 'b.com/y', 'B', '2024-01-01T00:00:02Z');

    const res = await listSyncKeys(getCtx(env, USER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('b1');
    expect(body.items[0].urlKey).toBe('a.com/x');
  });

  it('excludes deleted and private (E2E-encrypted) bookmarks', async () => {
    seedBm(db, 'live', USER, 'a.com/x', 'A', '2024-01-01T00:00:01Z');
    seedBm(db, 'trash', USER, 'a.com/t', 'T', '2024-01-01T00:00:02Z', { deleted_at: '2024-02-01T00:00:00Z' });
    seedBm(db, 'priv', USER, 'a.com/p', 'P', '2024-01-01T00:00:03Z', { is_private: 1, url: '', title: '' });

    const body = await (await listSyncKeys(getCtx(env, USER))).json();
    expect(body.items.map((i: any) => i.id)).toEqual(['live']);
  });

  it('paginates with a stable cursor and covers every live bookmark', async () => {
    for (let i = 1; i <= 5; i += 1) {
      seedBm(db, `b${i}`, USER, `a.com/${i}`, `B${i}`, `2024-01-01T00:00:0${i}Z`);
    }

    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const res = await listSyncKeys(getCtx(env, USER, { limit: '2', ...(cursor ? { cursor } : {}) }));
      const body = await res.json();
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((i: any) => i.id));
      cursor = body.cursor;
    } while (cursor);

    expect(seen.sort()).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
  });

  it('reports hasMore=false and a null cursor on the final page', async () => {
    seedBm(db, 'b1', USER, 'a.com/1', 'B1', '2024-01-01T00:00:01Z');

    const body = await (await listSyncKeys(getCtx(env, USER, { limit: '2' }))).json();
    expect(body.hasMore).toBe(false);
    expect(body.cursor).toBeNull();
  });

  it('sets the no-store cache header (per-account data must not be cached)', async () => {
    seedBm(db, 'b1', USER, 'a.com/x', 'A', '2024-01-01T00:00:01Z');
    const res = await listSyncKeys(getCtx(env, USER));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as statsTrend } from '../functions/api/stats/trend';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';
const OTHER = 'u2';

function makeCtx(env: Env, userId: string, days?: number) {
  const url = new URL('https://tagnest.test/api/stats/trend');
  if (days !== undefined) url.searchParams.set('days', String(days));
  return {
    request: new Request(url.toString(), { method: 'GET' }),
    env,
    data: { userId },
    params: {},
  } as any;
}

function seedBookmark(db: MockDb, id: string, createdAt: string, userId = USER, extra: Record<string, unknown> = {}) {
  db.bookmarks.push({
    id,
    user_id: userId,
    url: `https://example.com/${id}`,
    title: id,
    deleted_at: null,
    is_private: 0,
    created_at: createdAt,
    ...extra,
  });
}

describe('GET /api/stats/trend', () => {
  it('buckets additions by calendar day', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const now = Date.now();
    const day = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();
    seedBookmark(db, 'a', day(1));
    seedBookmark(db, 'b', day(1));
    seedBookmark(db, 'c', day(3));

    const res = await statsTrend(makeCtx(env, USER));
    const body = (await res.json()) as { days: Array<{ date: string; count: number }> };
    expect(body.days).toHaveLength(2);
    const byDate = new Map(body.days.map((d) => [d.date, d.count]));
    expect(byDate.get(day(1).slice(0, 10))).toBe(2);
    expect(byDate.get(day(3).slice(0, 10))).toBe(1);
  });

  it('excludes trashed and private bookmarks', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const now = new Date().toISOString();
    seedBookmark(db, 'live', now);
    seedBookmark(db, 'trashed', now, USER, { deleted_at: now });
    seedBookmark(db, 'private', now, USER, { is_private: 1 });

    const res = await statsTrend(makeCtx(env, USER));
    const body = (await res.json()) as { days: Array<{ count: number }> };
    const total = body.days.reduce((s, d) => s + d.count, 0);
    expect(total).toBe(1); // only the live, non-private one
  });

  it('never counts another user\'s bookmarks', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const now = new Date().toISOString();
    seedBookmark(db, 'mine', now);
    seedBookmark(db, 'theirs', now, OTHER);

    const res = await statsTrend(makeCtx(env, USER));
    const body = (await res.json()) as { days: Array<{ count: number }> };
    expect(body.days.reduce((s, d) => s + d.count, 0)).toBe(1);
  });

  it('caps the window at 365 days', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    // 400 days ago — outside even the capped window.
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    seedBookmark(db, 'ancient', old);
    seedBookmark(db, 'fresh', new Date().toISOString());

    const res = await statsTrend(makeCtx(env, USER, 9999));
    const body = (await res.json()) as { days: Array<{ date: string }> };
    expect(body.days.some((d) => d.date === old.slice(0, 10))).toBe(false);
    expect(body.days).toHaveLength(1);
  });

  it('ignores bookmarks older than the requested window', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    seedBookmark(db, 'old', old);
    seedBookmark(db, 'fresh', new Date().toISOString());

    const res = await statsTrend(makeCtx(env, USER, 7));
    const body = (await res.json()) as { days: Array<{ date: string }> };
    expect(body.days.some((d) => d.date === old.slice(0, 10))).toBe(false);
    expect(body.days).toHaveLength(1);
  });
});

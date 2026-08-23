// tests/stats.test.ts
//
// GET /api/stats — library headline numbers. CS-P4-2 adds the category
// coverage pair (`categorized` / `uncategorized`) the extension popup shows
// as "分类覆盖率" (C5-4). These tests pin the aggregate semantics: only
// live, visible, own bookmarks count, and the complement always adds up.

import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import type { Stats } from '../shared/types';
import { onRequestGet as statsGet } from '../functions/api/stats';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';
const OTHER = 'u2';

function makeCtx(env: Env, userId: string) {
  return {
    request: new Request('https://tagnest.test/api/stats', { method: 'GET' }),
    env,
    data: { userId },
    params: {},
  } as any;
}

function seedBookmark(
  db: MockDb,
  id: string,
  userId = USER,
  extra: Record<string, unknown> = {},
) {
  db.bookmarks.push({
    id,
    user_id: userId,
    url: `https://example.com/${id}`,
    title: id,
    deleted_at: null,
    is_private: 0,
    is_favorite: 0,
    is_archived: 0,
    created_at: new Date().toISOString(),
    ...extra,
  });
}

function seedCategory(db: MockDb, bookmarkId: string, tagId = 'tag-cat') {
  db.bookmark_primary_category.push({ bookmark_id: bookmarkId, tag_id: tagId, source: 'ai' });
}

async function getStats(env: Env, userId = USER): Promise<Stats> {
  const res = await statsGet(makeCtx(env, userId));
  return (await res.json()) as Stats;
}

describe('GET /api/stats — category coverage (CS-P4-2)', () => {
  it('counts bookmarks with a primary category as categorized', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, 'a');
    seedBookmark(db, 'b');
    seedBookmark(db, 'c');
    seedCategory(db, 'a');

    const stats = await getStats(env);
    expect(stats.bookmarks).toBe(3);
    expect(stats.categorized).toBe(1);
    expect(stats.uncategorized).toBe(2);
  });

  it('keeps categorized + uncategorized == bookmarks', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    for (let i = 0; i < 5; i += 1) seedBookmark(db, `b${i}`);
    seedCategory(db, 'b0');
    seedCategory(db, 'b1');

    const stats = await getStats(env);
    expect(stats.categorized + stats.uncategorized).toBe(stats.bookmarks);
  });

  it('does not count trashed bookmarks as categorized', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, 'live');
    seedBookmark(db, 'trashed', USER, { deleted_at: new Date().toISOString() });
    seedCategory(db, 'live');
    seedCategory(db, 'trashed');

    const stats = await getStats(env);
    expect(stats.bookmarks).toBe(1);
    expect(stats.categorized).toBe(1);
    expect(stats.uncategorized).toBe(0);
  });

  it('excludes private and private-tag-hidden bookmarks from coverage', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, 'plain');
    seedBookmark(db, 'vaulted', USER, { is_private: 1 });
    seedBookmark(db, 'hidden');
    // A private tag on `hidden` makes PRIVATE_BOOKMARK_CLAUSE drop the row.
    db.tags.push({ id: 'pt', user_id: USER, name: 'secret', is_private: 1 });
    db.bookmark_tags.push({ bookmark_id: 'hidden', tag_id: 'pt', source: 'manual' });
    seedCategory(db, 'plain');
    seedCategory(db, 'vaulted');
    seedCategory(db, 'hidden');

    const stats = await getStats(env);
    expect(stats.bookmarks).toBe(1); // only `plain` is visible
    expect(stats.categorized).toBe(1);
    expect(stats.uncategorized).toBe(0);
  });

  it('never counts another user\'s bookmarks or placements', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, 'mine');
    seedBookmark(db, 'theirs', OTHER);
    seedCategory(db, 'mine');
    seedCategory(db, 'theirs');

    const stats = await getStats(env);
    expect(stats.bookmarks).toBe(1);
    expect(stats.categorized).toBe(1);
    expect(stats.uncategorized).toBe(0);
  });

  it('returns zeros for an empty library', async () => {
    const env = makeEnv();
    const stats = await getStats(env);
    expect(stats.bookmarks).toBe(0);
    expect(stats.categorized).toBe(0);
    expect(stats.uncategorized).toBe(0);
  });
});

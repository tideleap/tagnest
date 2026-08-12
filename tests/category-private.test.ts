/**
 * Tests for category-level privacy (tags.is_private).
 *
 * Coverage:
 *  - PRIVATE_BOOKMARK_CLAUSE hides a bookmark that carries ANY private tag.
 *  - listBookmarks / loadBookmark cannot see a category-private bookmark, but
 *    the dedicated listing (listPrivateTagsWithBookmarks) surfaces it in clear.
 *  - setTagPrivate cascades (server-side recursive CTE) to the whole subtree:
 *    marking a parent private flips the parent and every descendant; clearing
 *    the parent flips them all back. Visibility is derived in SQL, so no
 *    bookmark row is ever rewritten.
 *  - The GET /api/private/tags handler returns the authorized listing only.
 */
import { describe, it, expect } from 'vitest';
import {
  PRIVATE_BOOKMARK_CLAUSE,
  listBookmarks,
  loadBookmark,
  listPrivateTagsWithBookmarks,
  setTagPrivate,
  type ListParams,
} from '../functions/_lib/db';
import { onRequestGet as getPrivateTags } from '../functions/api/private/tags';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u-cat';

function seedTag(
  db: MockDb,
  id: string,
  name: string,
  parentId: string | null = null,
  isPrivate = 0,
) {
  db.tags.push({
    id,
    user_id: USER,
    name,
    color_index: 0,
    parent_id: parentId,
    sort_order: 0,
    is_private: isPrivate,
    created_at: '2026-01-01T00:00:00Z',
  });
}

function seedBookmark(
  db: MockDb,
  id: string,
  title: string,
  tagIds: string[],
  over: Record<string, unknown> = {},
) {
  db.bookmarks.push({
    id,
    user_id: USER,
    url: `https://example.com/${id}`,
    url_key: `https://example.com/${id}`,
    title,
    favicon_url: null,
    description: null,
    note: null,
    cover_url: null,
    is_favorite: 0,
    is_archived: 0,
    is_private: 0,
    encrypted_blob: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  });
  for (const tagId of tagIds) db.bookmark_tags.push({ bookmark_id: id, tag_id: tagId });
}

function makeCtx(env: any, userId: string) {
  return {
    request: new Request('https://tagnest.test/api/private/tags', { method: 'GET' }),
    env,
    data: { userId },
    params: {},
  } as any;
}

const listParams = (tagIds: string[] = []): ListParams => ({
  userId: USER,
  scope: 'all',
  q: null,
  tagIds,
  matchAllTags: false,
  sort: 'created_desc',
  cursor: null,
  limit: 50,
});

/** Builds a parent→child tag tree plus a normal tag and fixtures. */
function seedTree(db: MockDb) {
  // 'adult' (parent) → 'video' (child); 'work' (normal); 'news' (normal)
  seedTag(db, 't-adult', '成人视频', null, 0);
  seedTag(db, 't-video', '视频', 't-adult', 0);
  seedTag(db, 't-work', '工作', null, 0);
  seedTag(db, 't-news', '资讯', null, 0);
  // b1 carries the private child tag; b2 carries a normal tag; b3 carries both.
  seedBookmark(db, 'b1', 'Hidden video', ['t-video']);
  seedBookmark(db, 'b2', 'Visible work', ['t-work']);
  seedBookmark(db, 'b3', 'Mixed', ['t-video', 't-news']);
  seedBookmark(db, 'b4', 'Plain news', ['t-news']);
}

describe('PRIVATE_BOOKMARK_CLAUSE', () => {
  it('excludes bookmarks carrying a private tag via NOT EXISTS', () => {
    expect(PRIVATE_BOOKMARK_CLAUSE).toContain('b.is_private = 0');
    expect(PRIVATE_BOOKMARK_CLAUSE).toContain('NOT EXISTS');
    expect(PRIVATE_BOOKMARK_CLAUSE).toContain('t_pv.is_private = 1');
  });
});

describe('category-private hiding in public reads', () => {
  it('hides a bookmark once its tag is marked private', async () => {
    const db = new MockDb();
    seedTree(db);
    const env = makeEnv();
    env.DB = db;

    // Before: all three relevant bookmarks are visible.
    let res = await listBookmarks(env, listParams());
    expect(res.items.map((i: any) => i.id).sort()).toEqual(['b1', 'b2', 'b3', 'b4']);

    // Mark the parent private → cascades to the child tag.
    await setTagPrivate(env, USER, 't-adult', true);

    res = await listBookmarks(env, listParams());
    const visible = res.items.map((i: any) => i.id).sort();
    expect(visible).toEqual(['b2', 'b4']); // b1 and b3 (carry private tag) gone
    expect(await loadBookmark(env, USER, 'b1')).toBeNull();
    expect(await loadBookmark(env, USER, 'b2')).not.toBeNull();

    // The private tag rows themselves reflect the flag.
    expect(db.tags.find((t) => t.id === 't-adult')!.is_private).toBe(1);
    expect(db.tags.find((t) => t.id === 't-video')!.is_private).toBe(1);
  });

  it('re-surfaces bookmarks after the category is un-private', async () => {
    const db = new MockDb();
    seedTree(db);
    const env = makeEnv();
    env.DB = db;

    await setTagPrivate(env, USER, 't-adult', true);
    expect((await listBookmarks(env, listParams())).items.length).toBe(2);

    await setTagPrivate(env, USER, 't-adult', false);
    const res = await listBookmarks(env, listParams());
    expect(res.items.map((i: any) => i.id).sort()).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(db.tags.find((t) => t.id === 't-adult')!.is_private).toBe(0);
    expect(db.tags.find((t) => t.id === 't-video')!.is_private).toBe(0);
  });
});

describe('listPrivateTagsWithBookmarks', () => {
  it('returns private tags grouped with their plaintext members', async () => {
    const db = new MockDb();
    seedTree(db);
    const env = makeEnv();
    env.DB = db;

    await setTagPrivate(env, USER, 't-adult', true);

    const entries = await listPrivateTagsWithBookmarks(env, USER);
    // t-adult and t-video are private; members grouped per tag.
    expect(entries.map((e) => e.tag.id).sort()).toEqual(['t-adult', 't-video']);

    const byTag = new Map(entries.map((e) => [e.tag.id, e.bookmarks.map((b) => b.id)]));
    // b1 is tagged with t-video (child); b3 is tagged with t-video AND t-news,
    // so it appears under the private tag t-video.
    expect(byTag.get('t-video')!.sort()).toEqual(['b1', 'b3']);
    expect(byTag.get('t-adult')).toEqual([]); // parent carries no direct bookmarks

    // Members are returned in clear (no encryption) and exclude trashed ones.
    const b1 = entries
      .flatMap((e) => e.bookmarks)
      .find((b) => b.id === 'b1')!;
    expect(b1.url).toBe('https://example.com/b1');
    expect(b1.title).toBe('Hidden video');
  });

  it('does not leak individually-vaulted bookmarks as plaintext members', async () => {
    const db = new MockDb();
    seedTree(db);
    const env = makeEnv();
    env.DB = db;

    // b1 is also individually vaulted (encrypted, plaintext blanked).
    db.bookmarks.find((b) => b.id === 'b1')!.is_private = 1;
    db.bookmarks.find((b) => b.id === 'b1')!.url = '';
    db.bookmarks.find((b) => b.id === 'b1')!.title = '';

    await setTagPrivate(env, USER, 't-adult', true);
    const entries = await listPrivateTagsWithBookmarks(env, USER);
    const members = entries.flatMap((e) => e.bookmarks);
    expect(members.find((b) => b.id === 'b1')).toBeUndefined();
  });
});

describe('GET /api/private/tags', () => {
  it('returns the authorized private-tags listing', async () => {
    const db = new MockDb();
    seedTree(db);
    const env = makeEnv();
    env.DB = db;

    await setTagPrivate(env, USER, 't-adult', true);

    const res = (await getPrivateTags(makeCtx(env, USER))) as Response;
    const body = (await res.json()) as { tags: Array<{ tag: any; bookmarks: any[] }> };
    expect(res.status).toBe(200);
    expect(body.tags.map((t) => t.tag.id).sort()).toEqual(['t-adult', 't-video']);
  });

  it('reflects setTagPrivate change count', async () => {
    const db = new MockDb();
    seedTree(db);
    const env = makeEnv();
    env.DB = db;
    // Marking t-adult private flips t-adult + t-video = 2 tags.
    expect(await setTagPrivate(env, USER, 't-adult', true)).toBe(2);
    // Already private → no change.
    expect(await setTagPrivate(env, USER, 't-adult', true)).toBe(0);
    // Clearing → 2 tags revert.
    expect(await setTagPrivate(env, USER, 't-adult', false)).toBe(2);
  });
});

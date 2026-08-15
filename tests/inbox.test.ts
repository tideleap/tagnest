/**
 * Contract tests for the inbox scope (B-1 / C2).
 *
 * The inbox is a *derived* scope — no column, no migration. A bookmark is "in
 * the inbox" when it is live (not deleted, not archived) and carries no tags.
 * Tagging it (manually or via an accepted AI suggestion) files it out of the
 * inbox automatically. These tests pin that behaviour at both the store level
 * (listBookmarks) and the endpoint level (GET /api/bookmarks?scope=inbox).
 */
import { describe, it, expect } from 'vitest';
import { listBookmarks, type ListParams } from '../functions/_lib/db';
import { onRequestGet as listEndpoint } from '../functions/api/bookmarks/index';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u-inbox';

function seedTag(db: MockDb, id: string, name: string, isPrivate = 0) {
  db.tags.push({
    id,
    user_id: USER,
    name,
    color_index: 0,
    parent_id: null,
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

const listParams = (over: Partial<ListParams> = {}): ListParams => ({
  userId: USER,
  scope: 'inbox',
  q: null,
  tagIds: [],
  matchAllTags: false,
  sort: 'created_desc',
  cursor: null,
  limit: 50,
  ...over,
});

function makeCtx(env: any, userId: string, query = '') {
  return {
    request: new Request(`https://tagnest.test/api/bookmarks${query}`, { method: 'GET' }),
    env,
    data: { userId },
    params: {},
  } as any;
}

describe('inbox scope (store level)', () => {
  it('shows an untagged, live bookmark', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', 'Fresh save', []);
    const env = makeEnv({ DB: db });
    const res = await listBookmarks(env, listParams());
    expect(res.items.map((i) => i.id)).toEqual(['b1']);
    expect(res.total).toBe(1);
  });

  it('hides a bookmark once it carries any tag', async () => {
    const db = new MockDb();
    seedTag(db, 't1', '工作');
    seedBookmark(db, 'b1', 'Untagged', []);
    seedBookmark(db, 'b2', 'Tagged', ['t1']);
    const env = makeEnv({ DB: db });
    const res = await listBookmarks(env, listParams());
    expect(res.items.map((i) => i.id)).toEqual(['b1']);
  });

  it('hides archived bookmarks', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', 'Live', []);
    seedBookmark(db, 'b2', 'Archived', [], { is_archived: 1 });
    const env = makeEnv({ DB: db });
    const res = await listBookmarks(env, listParams());
    expect(res.items.map((i) => i.id)).toEqual(['b1']);
  });

  it('hides deleted bookmarks', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', 'Live', []);
    seedBookmark(db, 'b2', 'Trashed', [], { deleted_at: '2026-01-02T00:00:00Z' });
    const env = makeEnv({ DB: db });
    const res = await listBookmarks(env, listParams());
    expect(res.items.map((i) => i.id)).toEqual(['b1']);
  });

  it('hides private bookmarks', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', 'Live', []);
    seedBookmark(db, 'b2', 'Secret', [], { is_private: 1 });
    const env = makeEnv({ DB: db });
    const res = await listBookmarks(env, listParams());
    expect(res.items.map((i) => i.id)).toEqual(['b1']);
  });

  it('hides bookmarks carrying a private tag', async () => {
    const db = new MockDb();
    seedTag(db, 't-priv', '私密', 1);
    seedBookmark(db, 'b1', 'Live', []);
    seedBookmark(db, 'b2', 'Category-private', ['t-priv']);
    const env = makeEnv({ DB: db });
    const res = await listBookmarks(env, listParams());
    expect(res.items.map((i) => i.id)).toEqual(['b1']);
  });

  it('filing a bookmark (adding a tag) removes it from the inbox', async () => {
    const db = new MockDb();
    seedTag(db, 't1', '阅读');
    seedBookmark(db, 'b1', 'Inbox item', []);
    const env = makeEnv({ DB: db });

    let res = await listBookmarks(env, listParams());
    expect(res.items.map((i) => i.id)).toEqual(['b1']);

    // Simulate filing: attach the tag.
    db.bookmark_tags.push({ bookmark_id: 'b1', tag_id: 't1' });
    res = await listBookmarks(env, listParams());
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('does not leak another user\'s untagged bookmarks', async () => {
    const db = new MockDb();
    seedBookmark(db, 'b1', 'Mine', []);
    // Another user's untagged bookmark.
    db.bookmarks.push({
      id: 'b-other',
      user_id: 'u-other',
      url: 'https://other.example/x',
      url_key: 'https://other.example/x',
      title: 'Theirs',
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
    });
    const env = makeEnv({ DB: db });
    const res = await listBookmarks(env, listParams());
    expect(res.items.map((i) => i.id)).toEqual(['b1']);
  });
});

describe('inbox scope (endpoint level)', () => {
  it('GET /api/bookmarks?scope=inbox returns only inbox items', async () => {
    const db = new MockDb();
    seedTag(db, 't1', '工作');
    seedBookmark(db, 'b1', 'Inbox', []);
    seedBookmark(db, 'b2', 'Filed', ['t1']);
    seedBookmark(db, 'b3', 'Archived', [], { is_archived: 1 });
    const env = makeEnv({ DB: db });

    const res = await listEndpoint(makeCtx(env, USER, '?scope=inbox'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[]; total: number };
    expect(body.items.map((i) => i.id)).toEqual(['b1']);
    expect(body.total).toBe(1);
  });

  it('an unknown scope falls back to all (not inbox)', async () => {
    const db = new MockDb();
    seedTag(db, 't1', '工作');
    seedBookmark(db, 'b1', 'Inbox', []);
    seedBookmark(db, 'b2', 'Filed', ['t1']);
    const env = makeEnv({ DB: db });

    const res = await listEndpoint(makeCtx(env, USER, '?scope=bogus'));
    const body = (await res.json()) as { items: { id: string }[] };
    // 'all' shows both live bookmarks regardless of tags.
    expect(body.items.map((i) => i.id).sort()).toEqual(['b1', 'b2']);
  });
});

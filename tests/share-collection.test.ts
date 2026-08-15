/**
 * Contract tests for collection-level shares (B-4 / H1).
 *
 * A share may reference a collection instead of a tag query; it then renders
 * the collection's bookmarks in membership order. A deleted collection makes
 * the share 404 (same semantics as a disabled share — no existence leak).
 */
import { describe, it, expect } from 'vitest';
import { onRequestGet as publicEndpoint } from '../functions/api/public/[slug]';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u-share';

function seedBookmark(db: MockDb, id: string, title: string, over: Record<string, unknown> = {}) {
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
}

function seedShare(db: MockDb, over: Record<string, unknown> = {}) {
  db.shares.push({
    id: 'sh1',
    user_id: USER,
    slug: 'my-list',
    title: '我的清单',
    description: null,
    tag_ids: '[]',
    match_all_tags: 0,
    include_notes: 0,
    theme: 'default',
    palette: 'light',
    is_active: 1,
    view_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    expires_at: null,
    password_hash: null,
    collection_id: null,
    ...over,
  });
}

function makeCtx(env: any, slug: string) {
  return {
    request: new Request(`https://tagnest.test/api/public/${slug}`),
    env,
    params: { slug },
    waitUntil: () => {},
  } as any;
}

describe('collection-level share (GET /api/public/:slug)', () => {
  it('renders the collection bookmarks in membership order', async () => {
    const db = new MockDb();
    const env = makeEnv({ DB: db });
    db.users.push({ id: USER, display_name: '分享者' });
    db.collections.push({
      id: 'c1', user_id: USER, name: '待读', color_index: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    });
    seedBookmark(db, 'b1', '第一篇');
    seedBookmark(db, 'b2', '第二篇');
    // Membership order is b2 first, b1 second — the share must follow it.
    db.collection_bookmarks.push(
      { collection_id: 'c1', bookmark_id: 'b2', position: 0, created_at: '2026-01-01T00:00:00Z' },
      { collection_id: 'c1', bookmark_id: 'b1', position: 1, created_at: '2026-01-01T00:00:00Z' },
    );
    seedShare(db, { collection_id: 'c1' });

    const res = await publicEndpoint(makeCtx(env, 'my-list'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['b2', 'b1']);
  });

  it('excludes trashed and private collection members', async () => {
    const db = new MockDb();
    const env = makeEnv({ DB: db });
    db.users.push({ id: USER, display_name: '分享者' });
    db.collections.push({
      id: 'c1', user_id: USER, name: '待读', color_index: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    });
    seedBookmark(db, 'b1', '正常');
    seedBookmark(db, 'b2', '已删除', { deleted_at: '2026-02-01T00:00:00Z' });
    seedBookmark(db, 'b3', '私密', { is_private: 1 });
    for (const id of ['b1', 'b2', 'b3']) {
      db.collection_bookmarks.push({
        collection_id: 'c1', bookmark_id: id, position: 0, created_at: '2026-01-01T00:00:00Z',
      });
    }
    seedShare(db, { collection_id: 'c1' });

    const res = await publicEndpoint(makeCtx(env, 'my-list'));
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['b1']);
  });

  it('answers 404 when the backing collection was deleted', async () => {
    const db = new MockDb();
    const env = makeEnv({ DB: db });
    // No collection seeded — the share points at a ghost.
    seedShare(db, { collection_id: 'ghost' });

    await expect(publicEndpoint(makeCtx(env, 'my-list'))).rejects.toMatchObject({ status: 404 });
  });

  it('answers 404 when the collection belongs to another user', async () => {
    const db = new MockDb();
    const env = makeEnv({ DB: db });
    db.collections.push({
      id: 'c-other', user_id: 'someone-else', name: '别人的', color_index: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    });
    seedShare(db, { collection_id: 'c-other' });

    await expect(publicEndpoint(makeCtx(env, 'my-list'))).rejects.toMatchObject({ status: 404 });
  });
});

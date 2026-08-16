import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as getSimilar } from '../functions/api/bookmarks/[id]/similar';
import {
  diceCoefficient,
  hostOf,
  jaccard,
  scoreBookmarkSimilarity,
  tokenize,
} from '../functions/_lib/similarity';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';

function makeCtx(env: Env, userId: string, path: string, id?: string) {
  return {
    request: new Request(`https://tagnest.test${path}`),
    env,
    data: { userId },
    params: id ? { id } : {},
  } as any;
}

let bmSeq = 0;
function seedBookmark(db: MockDb, over: Record<string, unknown> = {}) {
  bmSeq += 1;
  db.bookmarks.push({
    id: `b${bmSeq}`,
    user_id: USER,
    url: `https://example.com/${bmSeq}`,
    title: `Bookmark ${bmSeq}`,
    description: null,
    favicon_url: null,
    deleted_at: null,
    is_favorite: 0,
    is_private: 0,
    is_archived: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  });
  return db.bookmarks[db.bookmarks.length - 1];
}

function linkTag(db: MockDb, bookmarkId: string, tagId: string) {
  if (!db.bookmark_tags.some((bt) => bt.bookmark_id === bookmarkId && bt.tag_id === tagId)) {
    db.bookmark_tags.push({ bookmark_id: bookmarkId, tag_id: tagId });
  }
}

function ensureTag(db: MockDb, id: string, over: Record<string, unknown> = {}) {
  if (!db.tags.find((t) => t.id === id)) {
    db.tags.push({ id, name: id, color_index: 0, user_id: USER, created_at: '2026-01-01T00:00:00Z', ...over });
  }
}

describe('similarity (pure)', () => {
  it('hostOf strips scheme, path and www', () => {
    expect(hostOf('https://www.React.dev/path?x=1')).toBe('react.dev');
    expect(hostOf('example.com')).toBe('example.com');
    expect(hostOf('')).toBe('');
  });

  it('tokenize splits CJK per char and Latin per word', () => {
    expect(tokenize('React 指南 hooks')).toEqual(['react', '指', '南', 'hooks']);
    expect(tokenize(null)).toEqual([]);
  });

  it('dice and jaccard are 0..1 and symmetric enough', () => {
    expect(jaccard(['a', 'b'], ['a', 'b', 'c'])).toBeCloseTo(2 / 3, 5);
    expect(jaccard([], ['a'])).toBe(0);
    expect(diceCoefficient(['react', 'hooks'], ['react', 'api'])).toBeCloseTo(2 / 4, 5);
  });

  it('shared tags score higher than same-domain-only', () => {
    const source = { tagIds: ['t1'], url: 'https://react.dev/a', title: 'React guide', description: null, note: null };
    const tagOnly = { tagIds: ['t1'], url: 'https://other.com/x', title: 'unrelated', description: null, note: null };
    const domainOnly = { tagIds: [], url: 'https://react.dev/x', title: 'unrelated', description: null, note: null };
    expect(scoreBookmarkSimilarity(source, tagOnly)).toBeGreaterThan(scoreBookmarkSimilarity(source, domainOnly));
  });
});

describe('GET /api/bookmarks/:id/similar', () => {
  it('ranks a tag-sharing candidate above a domain-only one and hides unrelated', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    ensureTag(db, 't1');

    const src = seedBookmark(db, { url: 'https://react.dev/a', title: 'React docs', description: 'hooks tutorial', tags: [] });
    linkTag(db, src.id, 't1');
    const c1 = seedBookmark(db, { url: 'https://react.dev/b', title: 'React API', description: 'reference' });
    linkTag(db, c1.id, 't1');
    const c2 = seedBookmark(db, { url: 'https://react.dev/c', title: 'Cooking recipes', description: 'food' });
    const c3 = seedBookmark(db, { url: 'https://news.com/x', title: 'World news', description: 'politics' });

    const res = await getSimilar(makeCtx(env, USER, `/api/bookmarks/${src.id}/similar`, src.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((b: any) => b.id);
    expect(ids[0]).toBe(c1.id); // tag + domain wins
    expect(ids).toContain(c2.id); // domain-only included
    expect(ids).not.toContain(c3.id); // unrelated excluded
    expect(body.total).toBe(2);
  });

  it('excludes the source bookmark from its own similar list', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const src = seedBookmark(db, { url: 'https://react.dev/a', title: 'Only one' });
    const res = await getSimilar(makeCtx(env, USER, `/api/bookmarks/${src.id}/similar`, src.id));
    const body = await res.json();
    expect(body.items.map((b: any) => b.id)).not.toContain(src.id);
  });

  it('never leaks private bookmarks into a non-private source recommendations', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    ensureTag(db, 't1');
    const src = seedBookmark(db, { url: 'https://react.dev/a', title: 'React docs', description: 'hooks' });
    linkTag(db, src.id, 't1');
    const priv = seedBookmark(db, { url: 'https://react.dev/secret', title: 'React secret', description: 'private', is_private: 1 });
    linkTag(db, priv.id, 't1');

    const res = await getSimilar(makeCtx(env, USER, `/api/bookmarks/${src.id}/similar`, src.id));
    const body = await res.json();
    expect(body.items.map((b: any) => b.id)).not.toContain(priv.id);
  });

  it('clamps limit to the 30 maximum', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const src = seedBookmark(db, { url: 'https://react.dev/a', title: 'Source' });
    for (let i = 0; i < 40; i += 1) {
      seedBookmark(db, { url: `https://react.dev/${i}`, title: `Item ${i}` });
    }
    const res = await getSimilar(makeCtx(env, USER, `/api/bookmarks/${src.id}/similar?limit=50`, src.id));
    const body = await res.json();
    expect(body.items.length).toBeLessThanOrEqual(30);
  });

  it('returns 404 when the source bookmark is missing', async () => {
    const env = makeEnv();
    await expect(getSimilar(makeCtx(env, USER, '/api/bookmarks/nope/similar', 'nope'))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('returns an empty list when nothing is similar', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const src = seedBookmark(db, { url: 'https://react.dev/a', title: 'unique source' });
    const other = seedBookmark(db, { url: 'https://news.com/x', title: 'World news', description: 'politics' });
    const res = await getSimilar(makeCtx(env, USER, `/api/bookmarks/${src.id}/similar`, src.id));
    const body = await res.json();
    expect(body.items.map((b: any) => b.id)).not.toContain(other.id);
    expect(body.total).toBe(0);
  });
});

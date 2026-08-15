import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestPost as mergeTags } from '../functions/api/tags/merge';
import { onRequestGet as mergeLog } from '../functions/api/tags/merge-log';
import { onRequestPost as bulkDelete } from '../functions/api/tags/bulk-delete';
import { onRequestGet as taxonomyAudit } from '../functions/api/ai/taxonomy';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';
const OTHER = 'u2';

function makeCtx(env: Env, userId: string, body?: unknown) {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request('https://tagnest.test/api/tags/merge', init),
    env,
    data: { userId },
    params: {},
  } as any;
}

function makeGetCtx(env: Env, userId: string, url: string) {
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    data: { userId },
    params: {},
  } as any;
}

function seedTag(db: MockDb, id: string, name: string, userId = USER) {
  db.tags.push({
    id,
    user_id: userId,
    name,
    color_index: 0,
    parent_id: null,
    sort_order: 0,
    is_private: 0,
    created_at: '2026-01-01T00:00:00Z',
  });
}

function seedBookmark(db: MockDb, id: string, userId = USER) {
  db.bookmarks.push({
    id,
    user_id: userId,
    url: `https://example.com/${id}`,
    title: id,
    deleted_at: null,
    is_private: 0,
    created_at: '2026-01-01T00:00:00Z',
  });
}

describe('POST /api/tags/merge (single)', () => {
  it('repoints links, deletes sources, and writes an audit row', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedTag(db, 'keep', 'JavaScript');
    seedTag(db, 'dup1', 'js');
    seedTag(db, 'dup2', 'JS');
    seedBookmark(db, 'b1');
    seedBookmark(db, 'b2');
    db.bookmark_tags.push({ bookmark_id: 'b1', tag_id: 'dup1' });
    db.bookmark_tags.push({ bookmark_id: 'b2', tag_id: 'dup2' });

    const res = await mergeTags(
      makeCtx(env, USER, { sourceIds: ['dup1', 'dup2'], targetId: 'keep' }),
    );
    const body = (await res.json()) as { merged: number; clusters: number; logIds: string[] };
    expect(body.merged).toBe(2);
    expect(body.logIds).toHaveLength(1);

    // Links repointed to the target.
    expect(db.bookmark_tags.some((bt) => bt.bookmark_id === 'b1' && bt.tag_id === 'keep')).toBe(true);
    expect(db.bookmark_tags.some((bt) => bt.bookmark_id === 'b2' && bt.tag_id === 'keep')).toBe(true);
    // Source tags deleted.
    expect(db.tags.find((t) => t.id === 'dup1')).toBeUndefined();
    expect(db.tags.find((t) => t.id === 'dup2')).toBeUndefined();
    expect(db.tags.find((t) => t.id === 'keep')).toBeDefined();

    // Audit row snapshots names, not just ids.
    expect(db.tag_merge_log).toHaveLength(1);
    const log = db.tag_merge_log[0];
    expect(log.target_tag_name).toBe('JavaScript');
    expect(JSON.parse(String(log.source_tag_names))).toEqual(['js', 'JS']);
    expect(log.merged_count).toBe(2);
  });

  it('rejects a merge whose target does not exist with 404', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedTag(db, 'dup1', 'js');
    await expect(
      mergeTags(makeCtx(env, USER, { sourceIds: ['dup1'], targetId: 'ghost' })),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.tag_merge_log).toHaveLength(0);
  });

  it('never merges another user\'s source tags', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedTag(db, 'keep', 'JavaScript');
    seedTag(db, 'foreign', 'js', OTHER); // belongs to someone else
    // All sources filtered out as not owned → nothing to merge → 400.
    await expect(
      mergeTags(makeCtx(env, USER, { sourceIds: ['foreign'], targetId: 'keep' })),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.tags.find((t) => t.id === 'foreign')).toBeDefined(); // untouched
    expect(db.tag_merge_log).toHaveLength(0);
  });
});

describe('POST /api/tags/merge (batch clusters)', () => {
  it('merges every cluster in one request and logs each', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedTag(db, 'js', 'JavaScript');
    seedTag(db, 'jsdup', 'js');
    seedTag(db, 'css', 'CSS');
    seedTag(db, 'cssdup', 'css');
    seedBookmark(db, 'b1');
    db.bookmark_tags.push({ bookmark_id: 'b1', tag_id: 'jsdup' });
    db.bookmark_tags.push({ bookmark_id: 'b1', tag_id: 'cssdup' });

    const res = await mergeTags(
      makeCtx(env, USER, {
        clusters: [
          { sourceIds: ['jsdup'], targetId: 'js' },
          { sourceIds: ['cssdup'], targetId: 'css' },
        ],
      }),
    );
    const body = (await res.json()) as { merged: number; clusters: number; logIds: string[] };
    expect(body.merged).toBe(2);
    expect(body.clusters).toBe(2);
    expect(body.logIds).toHaveLength(2);
    expect(db.tag_merge_log).toHaveLength(2);
    expect(db.tags.find((t) => t.id === 'jsdup')).toBeUndefined();
    expect(db.tags.find((t) => t.id === 'cssdup')).toBeUndefined();
  });

  it('rejects an empty cluster list with 400', async () => {
    const env = makeEnv();
    await expect(mergeTags(makeCtx(env, USER, { clusters: [] }))).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('POST /api/tags/bulk-delete', () => {
  it('deletes only the caller\'s tags and reports the count', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedTag(db, 'a', 'unused-a');
    seedTag(db, 'b', 'unused-b');
    seedTag(db, 'foreign', 'unused-x', OTHER);

    const res = await bulkDelete(makeCtx(env, USER, { ids: ['a', 'b', 'foreign'] }));
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(2); // foreign tag not counted
    expect(db.tags.find((t) => t.id === 'foreign')).toBeDefined();
    expect(db.tags.find((t) => t.id === 'a')).toBeUndefined();
  });

  it('rejects an empty id list with 400', async () => {
    const env = makeEnv();
    await expect(bulkDelete(makeCtx(env, USER, { ids: [] }))).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('GET /api/tags/merge-log', () => {
  it('returns the caller\'s merges newest-first and hides other users\'', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    db.tag_merge_log.push(
      {
        id: 'l1',
        user_id: USER,
        target_tag_id: 'keep',
        target_tag_name: 'JavaScript',
        source_tag_names: JSON.stringify(['js']),
        merged_count: 1,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'l2',
        user_id: USER,
        target_tag_id: 'css',
        target_tag_name: 'CSS',
        source_tag_names: JSON.stringify(['css2']),
        merged_count: 1,
        created_at: '2026-02-01T00:00:00Z',
      },
      {
        id: 'l3',
        user_id: OTHER,
        target_tag_id: 'x',
        target_tag_name: 'X',
        source_tag_names: JSON.stringify(['y']),
        merged_count: 1,
        created_at: '2026-03-01T00:00:00Z',
      },
    );

    const res = await mergeLog(makeGetCtx(env, USER, 'https://tagnest.test/api/tags/merge-log'));
    const body = (await res.json()) as Array<{ id: string; sourceTagNames: string[] }>;
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe('l2'); // newest first
    expect(body[0].sourceTagNames).toEqual(['css2']);
    expect(body.some((e) => e.id === 'l3')).toBe(false); // other user hidden
  });
});

describe('GET /api/ai/taxonomy (lowUsage)', () => {
  it('reports count-1 tags as lowUsage and count-0 as unused', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedTag(db, 't0', 'orphan'); // count 0
    seedTag(db, 't1', 'rare'); // count 1
    seedTag(db, 't2', 'busy'); // count 2
    seedBookmark(db, 'b1');
    seedBookmark(db, 'b2');
    db.bookmark_tags.push({ bookmark_id: 'b1', tag_id: 't1' });
    db.bookmark_tags.push({ bookmark_id: 'b1', tag_id: 't2' });
    db.bookmark_tags.push({ bookmark_id: 'b2', tag_id: 't2' });

    const res = await taxonomyAudit(makeGetCtx(env, USER, 'https://tagnest.test/api/ai/taxonomy'));
    const body = (await res.json()) as {
      totalTags: number;
      unused: Array<{ id: string }>;
      lowUsage: Array<{ id: string; count: number }>;
    };
    expect(body.totalTags).toBe(3);
    expect(body.unused.map((t) => t.id)).toEqual(['t0']);
    expect(body.lowUsage.map((t) => t.id)).toEqual(['t1']);
    expect(body.lowUsage[0].count).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as listJobs, onRequestPost as createJobHandler } from '../functions/api/ai/jobs/index';
import {
  onRequestGet as getJobHandler,
  onRequestDelete as cancelJobHandler,
} from '../functions/api/ai/jobs/[id]';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';

function ctx(env: Env, userId: string, method: string, id?: string) {
  const url = id
    ? `https://tagnest.test/api/ai/jobs/${id}`
    : 'https://tagnest.test/api/ai/jobs';
  return {
    request: new Request(url, { method }),
    env,
    data: { userId },
    params: id ? { id } : {},
  } as any;
}

function postCtx(env: Env, userId: string, body: Record<string, unknown>) {
  return {
    request: new Request('https://tagnest.test/api/ai/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    data: { userId },
    params: {},
  } as any;
}

function seedBookmark(db: MockDb, id: string, createdAt: string) {
  db.bookmarks.push({
    id,
    user_id: USER,
    url: `https://${id}.example.com/article`,
    title: `书签 ${id}`,
    description: null,
    deleted_at: null,
    is_private: 0,
    created_at: createdAt,
  });
}

function pushJob(db: MockDb, over: Record<string, unknown> = {}) {
  db.ai_jobs.push({
    id: 'j1',
    user_id: USER,
    kind: 'tagging',
    status: 'running',
    scope: JSON.stringify({ target: 'untagged', ids: ['b1', 'b2'] }),
    total: 2,
    processed: 1,
    suggested: 3,
    failed: 0,
    engine: 'model',
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  });
}

describe('GET /api/ai/jobs', () => {
  it('returns the user’s runs ordered by created_at descending', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    db.ai_jobs.push({
      id: 'older',
      user_id: USER,
      kind: 'tagging',
      status: 'done',
      scope: JSON.stringify({ target: 'all', ids: [] }),
      total: 5,
      processed: 5,
      suggested: 4,
      failed: 0,
      engine: 'model',
      error: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    db.ai_jobs.push({
      id: 'newer',
      user_id: USER,
      kind: 'tagging',
      status: 'running',
      scope: JSON.stringify({ target: 'untagged', ids: ['b1'] }),
      total: 1,
      processed: 0,
      suggested: 0,
      failed: 0,
      engine: null,
      error: null,
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    });

    const res = await listJobs(ctx(env, USER, 'GET'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ id: string; target?: string }> };
    expect(body.jobs.map((j) => j.id)).toEqual(['newer', 'older']);
    // The run scope target is surfaced on the DTO.
    expect(body.jobs[1].target).toBe('all');
  });

  it('does not leak another user’s runs', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    db.ai_jobs.push({
      id: 'theirs',
      user_id: 'other',
      kind: 'tagging',
      status: 'done',
      scope: JSON.stringify({ target: 'all', ids: [] }),
      total: 1,
      processed: 1,
      suggested: 0,
      failed: 0,
      engine: null,
      error: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const res = await listJobs(ctx(env, USER, 'GET'));
    const body = (await res.json()) as { jobs: unknown[] };
    expect(body.jobs).toHaveLength(0);
  });
});

describe('GET /api/ai/jobs/:id', () => {
  it('returns the matching run', async () => {
    const env = makeEnv();
    pushJob(env.DB as MockDb, { id: 'j1', status: 'running' });

    const res = await getJobHandler(ctx(env, USER, 'GET', 'j1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string; target?: string } };
    expect(body.job.id).toBe('j1');
    expect(body.job.target).toBe('untagged');
  });

  it('returns 404 for an unknown id', async () => {
    const env = makeEnv();
    await expect(getJobHandler(ctx(env, USER, 'GET', 'nope'))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('DELETE /api/ai/jobs/:id', () => {
  it('cancels a running run', async () => {
    const env = makeEnv();
    pushJob(env.DB as MockDb, { id: 'j1', status: 'running' });

    const res = await cancelJobHandler(ctx(env, USER, 'DELETE', 'j1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { status: string } };
    expect(body.job.status).toBe('cancelled');
  });

  it('leaves a finished run untouched (no destructive delete)', async () => {
    const env = makeEnv();
    pushJob(env.DB as MockDb, { id: 'j1', status: 'done' });

    const res = await cancelJobHandler(ctx(env, USER, 'DELETE', 'j1'));
    const body = (await res.json()) as { job: { status: string } };
    expect(body.job.status).toBe('done');
  });

  it('returns 404 for an unknown id', async () => {
    const env = makeEnv();
    await expect(cancelJobHandler(ctx(env, USER, 'DELETE', 'nope'))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('POST /api/ai/jobs', () => {
  it('snapshots the whole untagged scope by default', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, 'b1', '2026-01-01T00:00:00Z');
    seedBookmark(db, 'b2', '2026-01-02T00:00:00Z');
    seedBookmark(db, 'b3', '2026-01-03T00:00:00Z');

    const res = await createJobHandler(postCtx(env, USER, { target: 'untagged' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { id: string; total: number } };
    expect(body.job.total).toBe(3);
    // The scope snapshot is persisted on the job row.
    const row = db.ai_jobs.find((j) => j.id === body.job.id);
    const scope = JSON.parse(String(row?.scope)) as { target: string; ids: string[] };
    expect(scope.target).toBe('untagged');
    expect(scope.ids).toHaveLength(3);
  });

  it('clips the snapshot to `limit` for a trial run', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    for (let i = 1; i <= 5; i += 1) {
      seedBookmark(db, `b${i}`, `2026-01-0${i}T00:00:00Z`);
    }

    const res = await createJobHandler(postCtx(env, USER, { target: 'untagged', limit: 2 }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { total: number } };
    expect(body.job.total).toBe(2);
    // Newest first: the trial takes the two most recent bookmarks.
    const row = db.ai_jobs[db.ai_jobs.length - 1];
    const scope = JSON.parse(String(row.scope)) as { ids: string[] };
    expect(scope.ids).toEqual(['b5', 'b4']);
  });

  it('caps `limit` at the per-run maximum', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, 'b1', '2026-01-01T00:00:00Z');

    const res = await createJobHandler(postCtx(env, USER, { target: 'untagged', limit: 99999 }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { total: number } };
    expect(body.job.total).toBe(1);
  });

  it('ignores a non-positive limit', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, 'b1', '2026-01-01T00:00:00Z');
    seedBookmark(db, 'b2', '2026-01-02T00:00:00Z');

    const res = await createJobHandler(postCtx(env, USER, { target: 'untagged', limit: 0 }));
    const body = (await res.json()) as { job: { total: number } };
    expect(body.job.total).toBe(2);
  });

  it('rejects an empty untagged scope with a dedicated code', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    // The only bookmark already carries a tag, so the untagged scope is empty.
    seedBookmark(db, 'b1', '2026-01-01T00:00:00Z');
    db.tags.push({ id: 't1', user_id: USER, name: '已有', is_private: 0 });
    db.bookmark_tags.push({ bookmark_id: 'b1', tag_id: 't1', source: 'user' });

    await expect(createJobHandler(postCtx(env, USER, { target: 'untagged' }))).rejects.toMatchObject({
      status: 400,
      code: 'ai_scope_empty',
    });
    expect(db.ai_jobs).toHaveLength(0);
  });

  it('rejects target=ids without ids', async () => {
    const env = makeEnv();
    await expect(createJobHandler(postCtx(env, USER, { target: 'ids' }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects an invalid target', async () => {
    const env = makeEnv();
    await expect(createJobHandler(postCtx(env, USER, { target: 'bogus' }))).rejects.toMatchObject({
      status: 400,
    });
  });
});

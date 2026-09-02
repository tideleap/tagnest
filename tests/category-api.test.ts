import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as treeHandler } from '../functions/api/category/tree';
import { onRequestPost as assignHandler } from '../functions/api/category/assign';
import { onRequestPost as createJobHandler } from '../functions/api/ai/jobs/index';
import { onRequestPost as runHandler } from '../functions/api/ai/jobs/[id]/run';
import { onRequestPost as finalizeHandler } from '../functions/api/ai/jobs/[id]/finalize';
import { onRequestPost as undoHandler } from '../functions/api/ai/jobs/[id]/undo';
import { onRequestGet as suggestionsHandler } from '../functions/api/ai/suggestions/index';
import { onRequestPost as applyHandler } from '../functions/api/ai/suggestions/apply';
import { createAiDb, type AiDbState } from './helpers/aiDb';

/**
 * Endpoint tests for the CategorySync P1 surface:
 *  - GET /api/category/tree (tree + writeback formats)
 *  - POST /api/category/assign (manual re-classification)
 *  - POST /api/ai/jobs kind='categorize' (scope resolution)
 *  - POST /api/ai/jobs/:id/run (categorize branch)
 *  - POST /api/ai/jobs/:id/undo (categorize undo)
 *  - GET /api/ai/suggestions?kind=category (queue filter)
 *  - POST /api/ai/suggestions/apply kind='category' (decide routing)
 */

const USER = 'u1';

function makeAiEnv(seed?: Partial<AiDbState>): { env: Env; state: AiDbState } {
  const { db, state } = createAiDb(seed);
  return { env: { DB: db as never, LOG_LEVEL: 'error' } as unknown as Env, state };
}

function treeCtx(env: Env, query = '') {
  return {
    request: new Request(`https://tagnest.test/api/category/tree${query}`),
    env,
    data: { userId: USER },
    params: {},
  } as any;
}

function assignCtx(env: Env, body: Record<string, unknown>) {
  return {
    request: new Request('https://tagnest.test/api/category/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    data: { userId: USER },
    params: {},
  } as any;
}

function jobCtx(env: Env, body: Record<string, unknown>) {
  return {
    request: new Request('https://tagnest.test/api/ai/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    data: { userId: USER },
    params: {},
  } as any;
}

function runCtx(env: Env, jobId: string) {
  return {
    request: new Request(`https://tagnest.test/api/ai/jobs/${jobId}/run`, { method: 'POST' }),
    env,
    data: { userId: USER },
    params: { id: jobId },
  } as any;
}

function finalizeCtx(env: Env, jobId: string) {
  return {
    request: new Request(`https://tagnest.test/api/ai/jobs/${jobId}/finalize`, { method: 'POST' }),
    env,
    data: { userId: USER },
    params: { id: jobId },
  } as any;
}

function undoCtx(env: Env, jobId: string) {
  return {
    request: new Request(`https://tagnest.test/api/ai/jobs/${jobId}/undo`, { method: 'POST' }),
    env,
    data: { userId: USER },
    params: { id: jobId },
  } as any;
}

function suggestionsCtx(env: Env, query = '') {
  return {
    request: new Request(`https://tagnest.test/api/ai/suggestions${query}`),
    env,
    data: { userId: USER },
    params: {},
  } as any;
}

function applyCtx(env: Env, body: Record<string, unknown>) {
  return {
    request: new Request('https://tagnest.test/api/ai/suggestions/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    data: { userId: USER },
    params: {},
  } as any;
}

/* ------------------------------------------------------------------ *
 * Seed helpers
 * ------------------------------------------------------------------ */

function baseSeed(): AiDbState {
  return {
    tags: [
      { id: 'dev', user_id: USER, name: '开发技术', color_index: 0, parent_id: null, sort_order: 0, created_at: '2026' },
      { id: 'fe', user_id: USER, name: '前端开发', color_index: 1, parent_id: 'dev', sort_order: 0, created_at: '2026' },
      { id: 'tools', user_id: USER, name: '在线工具', color_index: 2, parent_id: null, sort_order: 1, created_at: '2026' },
    ],
    bookmarks: [
      { id: 'b1', user_id: USER, url: 'https://react.dev/learn', title: 'React 文档', description: null, deleted_at: null, ai_summary: null, created_at: '2026-01-01T00:00:00Z' },
      { id: 'b2', user_id: USER, url: 'https://github.com/foo/bar', title: 'A repo', description: null, deleted_at: null, ai_summary: null, created_at: '2026-01-02T00:00:00Z' },
      { id: 'b3', user_id: USER, url: 'https://figma.com/file', title: 'Design', description: null, deleted_at: null, ai_summary: null, created_at: '2026-01-03T00:00:00Z' },
    ],
    bookmark_tags: [],
    tag_suggestions: [],
    ai_feedback: [],
    ai_jobs: [],
    ai_settings: [],
    bookmark_primary_category: [],
  };
}

/* ------------------------------------------------------------------ *
 * GET /api/category/tree
 * ------------------------------------------------------------------ */

describe('GET /api/category/tree', () => {
  it('returns the tag tree with placement counts', async () => {
    const seed = baseSeed();
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: 0.9, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
      { bookmark_id: 'b2', tag_id: 'tools', confidence: 0.8, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
    ];
    const { env } = makeAiEnv(seed);

    const res = await treeHandler(treeCtx(env));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree: Array<{ tagId: string; name: string; count: number; children: unknown[] }> };

    // Two roots: 开发技术 (with child 前端开发) and 在线工具.
    expect(body.tree).toHaveLength(2);
    const dev = body.tree.find((n) => n.tagId === 'dev');
    expect(dev).toBeDefined();
    expect(dev!.count).toBe(1); // subtree total: b1 under fe
    expect(dev!.children).toHaveLength(1);

    const tools = body.tree.find((n) => n.tagId === 'tools');
    expect(tools!.count).toBe(1);
  });

  it('rejects an invalid format param', async () => {
    const { env } = makeAiEnv(baseSeed());
    await expect(treeHandler(treeCtx(env, '?format=bogus'))).rejects.toMatchObject({ status: 400 });
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/category/tree?format=writeback
 * ------------------------------------------------------------------ */

describe('GET /api/category/tree?format=writeback', () => {
  it('returns paged items with derived categoryPath', async () => {
    const seed = baseSeed();
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: 0.9, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
      { bookmark_id: 'b2', tag_id: 'tools', confidence: 0.8, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
    ];
    const { env } = makeAiEnv(seed);

    const res = await treeHandler(treeCtx(env, '?format=writeback'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ bookmarkId: string; url: string; title: string; categoryPath: string[] | null }>;
      nextCursor: string | null;
      total: number;
    };

    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();

    // b1 → fe → dev: path is ['开发技术', '前端开发']
    const item1 = body.items.find((i) => i.bookmarkId === 'b1');
    expect(item1!.categoryPath).toEqual(['开发技术', '前端开发']);

    // b2 → tools: path is ['在线工具']
    const item2 = body.items.find((i) => i.bookmarkId === 'b2');
    expect(item2!.categoryPath).toEqual(['在线工具']);
  });

  it('paginates with cursor', async () => {
    const seed = baseSeed();
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: 0.9, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
      { bookmark_id: 'b2', tag_id: 'tools', confidence: 0.8, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
      { bookmark_id: 'b3', tag_id: 'dev', confidence: 0.7, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
    ];
    const { env } = makeAiEnv(seed);

    // First page: limit=2
    const res1 = await treeHandler(treeCtx(env, '?format=writeback&limit=2'));
    const page1 = (await res1.json()) as { items: Array<{ bookmarkId: string }>; nextCursor: string | null; total: number };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe('b2'); // last item's bookmarkId
    expect(page1.total).toBe(3);

    // Second page: cursor=b2
    const res2 = await treeHandler(treeCtx(env, `?format=writeback&limit=2&cursor=${page1.nextCursor}`));
    const page2 = (await res2.json()) as { items: Array<{ bookmarkId: string }>; nextCursor: string | null };
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].bookmarkId).toBe('b3');
    expect(page2.nextCursor).toBeNull();
  });

  it('excludes non-accepted placements', async () => {
    const seed = baseSeed();
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: 0.9, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
      { bookmark_id: 'b2', tag_id: 'tools', confidence: 0.8, source: 'ai', job_id: 'j1', status: 'pending', decided_at: null, updated_at: '2026' },
    ];
    const { env } = makeAiEnv(seed);

    const res = await treeHandler(treeCtx(env, '?format=writeback'));
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * POST /api/category/assign
 * ------------------------------------------------------------------ */

describe('POST /api/category/assign', () => {
  it('writes manual placements and returns count', async () => {
    const seed = baseSeed();
    const { env, state } = makeAiEnv(seed);

    const res = await assignHandler(assignCtx(env, { bookmark_ids: ['b1', 'b2'], tag_id: 'fe' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assigned: number };
    expect(body.assigned).toBe(2);

    // Placements written with source='manual'.
    expect(state.bookmark_primary_category).toHaveLength(2);
    expect(state.bookmark_primary_category[0].source).toBe('manual');
    expect(state.bookmark_primary_category[0].tag_id).toBe('fe');
  });

  it('accepts camelCase params', async () => {
    const seed = baseSeed();
    const { env, state } = makeAiEnv(seed);

    const res = await assignHandler(assignCtx(env, { bookmarkIds: ['b1'], tagId: 'tools' }));
    expect(res.status).toBe(200);
    expect(state.bookmark_primary_category).toHaveLength(1);
    expect(state.bookmark_primary_category[0].tag_id).toBe('tools');
  });

  it('rejects empty bookmark list', async () => {
    const { env } = makeAiEnv(baseSeed());
    await expect(assignHandler(assignCtx(env, { bookmark_ids: [], tag_id: 'fe' }))).rejects.toMatchObject({ status: 400 });
  });

  it('rejects missing tag_id', async () => {
    const { env } = makeAiEnv(baseSeed());
    await expect(assignHandler(assignCtx(env, { bookmark_ids: ['b1'] }))).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a tag not owned by the user', async () => {
    const seed = baseSeed();
    seed.tags.push({ id: 'other-tag', user_id: 'other', name: '别人的', color_index: 0, parent_id: null, sort_order: 0, created_at: '2026' });
    const { env } = makeAiEnv(seed);

    await expect(assignHandler(assignCtx(env, { bookmark_ids: ['b1'], tag_id: 'other-tag' }))).rejects.toMatchObject({ status: 400 });
  });

  it('overwrites an existing placement in place', async () => {
    const seed = baseSeed();
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: 0.9, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
    ];
    const { env, state } = makeAiEnv(seed);

    await assignHandler(assignCtx(env, { bookmark_ids: ['b1'], tag_id: 'tools' }));
    expect(state.bookmark_primary_category).toHaveLength(1);
    expect(state.bookmark_primary_category[0].tag_id).toBe('tools');
    expect(state.bookmark_primary_category[0].source).toBe('manual');
  });
});

/* ------------------------------------------------------------------ *
 * POST /api/ai/jobs kind='categorize'
 * ------------------------------------------------------------------ */

describe('POST /api/ai/jobs kind=categorize', () => {
  it('creates a categorize job with correct scope', async () => {
    const seed = baseSeed();
    const { env, state } = makeAiEnv(seed);

    const res = await createJobHandler(jobCtx(env, { kind: 'categorize', target: 'untagged' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { id: string; total: number } };
    // All 3 bookmarks have no primary category → all in scope.
    expect(body.job.total).toBe(3);

    const job = state.ai_jobs.find((j) => j.id === body.job.id);
    expect(job!.kind).toBe('categorize');
  });

  it('skips bookmarks with browser_folder placement', async () => {
    const seed = baseSeed();
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: null, source: 'browser_folder', job_id: null, status: 'accepted', decided_at: null, updated_at: '2026' },
    ];
    const { env } = makeAiEnv(seed);

    const res = await createJobHandler(jobCtx(env, { kind: 'categorize', target: 'all' }));
    const body = (await res.json()) as { job: { total: number } };
    // b1 has browser_folder placement → skipped; b2, b3 remain.
    expect(body.job.total).toBe(2);
  });

  it('includes browser_folder bookmarks when opted in', async () => {
    const seed = baseSeed();
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: null, source: 'browser_folder', job_id: null, status: 'accepted', decided_at: null, updated_at: '2026' },
    ];
    const { env } = makeAiEnv(seed);

    const res = await createJobHandler(jobCtx(env, { kind: 'categorize', target: 'all', includeBrowserFolder: true }));
    const body = (await res.json()) as { job: { total: number } };
    expect(body.job.total).toBe(3);
  });

  it('rejects empty categorize scope with dedicated message', async () => {
    const seed = baseSeed();
    // All bookmarks already have primary categories.
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: 0.9, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
      { bookmark_id: 'b2', tag_id: 'tools', confidence: 0.8, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
      { bookmark_id: 'b3', tag_id: 'dev', confidence: 0.7, source: 'ai', job_id: 'j1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
    ];
    const { env } = makeAiEnv(seed);

    await expect(
      createJobHandler(jobCtx(env, { kind: 'categorize', target: 'untagged' })),
    ).rejects.toMatchObject({ status: 400, code: 'ai_scope_empty' });
  });

  it('rejects invalid kind', async () => {
    const { env } = makeAiEnv(baseSeed());
    await expect(createJobHandler(jobCtx(env, { kind: 'bogus' }))).rejects.toMatchObject({ status: 400 });
  });
});

/* ------------------------------------------------------------------ *
 * POST /api/ai/jobs/:id/run — categorize branch
 * ------------------------------------------------------------------ */

describe('POST /api/ai/jobs/:id/run — categorize', () => {
  it('processes bookmarks via fallback engine and saves category suggestions', async () => {
    const seed = baseSeed();
    // Seed a queued categorize job with b1 in scope.
    seed.ai_jobs = [
      {
        id: 'cj1', user_id: USER, kind: 'categorize', status: 'queued',
        scope: JSON.stringify({ target: 'ids', ids: ['b1'] }),
        total: 1, processed: 0, suggested: 0, failed: 0,
        engine: null, error: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        prompt_version: '2026-08-22',
      },
    ];
    const { env, state } = makeAiEnv(seed);

    const res = await runHandler(runCtx(env, 'cj1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      done: boolean;
      suggested: number;
      engine: string;
      uncategorized?: number;
    };

    expect(body.done).toBe(true);
    expect(body.engine).toBe('fallback');
    expect(body.suggested).toBe(1);

    // A category suggestion was saved.
    const catSuggestions = state.tag_suggestions.filter((s) => s.kind === 'category');
    expect(catSuggestions).toHaveLength(1);
    expect(catSuggestions[0].bookmark_id).toBe('b1');
    expect(catSuggestions[0].status).toBe('pending');

    // 方案A：/run 不再内联 finalize，末分片仅将任务置为 finalizing 待收尾。
    let job = state.ai_jobs.find((j) => j.id === 'cj1')!;
    expect(job.status).toBe('finalizing');
    expect(job.processed).toBe(1);

    // 真实生产流程由前端在 finalizing 后调用独立的 /finalize 端点完成收尾置 done。
    const fres = await finalizeHandler(finalizeCtx(env, 'cj1'));
    expect(fres.status).toBe(200);
    job = state.ai_jobs.find((j) => j.id === 'cj1')!;
    expect(job.status).toBe('done');
    expect(job.processed).toBe(1);
  });

  it('returns 404 for unknown job', async () => {
    const { env } = makeAiEnv(baseSeed());
    await expect(runHandler(runCtx(env, 'nope'))).rejects.toMatchObject({ status: 404 });
  });

  it('returns 409 for a cancelled job', async () => {
    const seed = baseSeed();
    seed.ai_jobs = [
      {
        id: 'cj1', user_id: USER, kind: 'categorize', status: 'cancelled',
        scope: JSON.stringify({ target: 'ids', ids: ['b1'] }),
        total: 1, processed: 0, suggested: 0, failed: 0,
        engine: null, error: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        prompt_version: null,
      },
    ];
    const { env } = makeAiEnv(seed);
    await expect(runHandler(runCtx(env, 'cj1'))).rejects.toMatchObject({ status: 409 });
  });
});

/* ------------------------------------------------------------------ *
 * POST /api/ai/jobs/:id/undo — categorize branch
 * ------------------------------------------------------------------ */

describe('POST /api/ai/jobs/:id/undo — categorize', () => {
  it('removes AI placements and restores suggestions to pending', async () => {
    const seed = baseSeed();
    seed.ai_jobs = [
      {
        id: 'cj1', user_id: USER, kind: 'categorize', status: 'done',
        scope: JSON.stringify({ target: 'ids', ids: ['b1'] }),
        total: 1, processed: 1, suggested: 1, failed: 0,
        engine: 'fallback', error: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
        prompt_version: '2026-08-22',
      },
    ];
    seed.tag_suggestions = [
      {
        id: 'cs1', user_id: USER, bookmark_id: 'b1', job_id: 'cj1',
        tag_name: '开发技术 > 前端开发', tag_id: 'fe', confidence: 0.9,
        source: 'fallback', reason: null, kind: 'category',
        status: 'accepted', decided_at: '2026-01-02T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
      },
    ];
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: 0.9, source: 'ai', job_id: 'cj1', status: 'accepted', decided_at: '2026', updated_at: '2026' },
    ];
    const { env, state } = makeAiEnv(seed);

    const res = await undoHandler(undoCtx(env, 'cj1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removedPlacements: number; restoredSuggestions: number };
    expect(body.removedPlacements).toBe(1);
    expect(body.restoredSuggestions).toBe(1);

    // Placement removed, suggestion back to pending.
    expect(state.bookmark_primary_category).toHaveLength(0);
    expect(state.tag_suggestions[0].status).toBe('pending');
  });

  it('does not touch manual placements', async () => {
    const seed = baseSeed();
    seed.ai_jobs = [
      {
        id: 'cj1', user_id: USER, kind: 'categorize', status: 'done',
        scope: JSON.stringify({ target: 'ids', ids: ['b1'] }),
        total: 1, processed: 1, suggested: 1, failed: 0,
        engine: 'fallback', error: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
        prompt_version: '2026-08-22',
      },
    ];
    seed.bookmark_primary_category = [
      { bookmark_id: 'b1', tag_id: 'fe', confidence: null, source: 'manual', job_id: null, status: 'accepted', decided_at: '2026', updated_at: '2026' },
    ];
    const { env, state } = makeAiEnv(seed);

    const res = await undoHandler(undoCtx(env, 'cj1'));
    const body = (await res.json()) as { removedPlacements: number };
    expect(body.removedPlacements).toBe(0);
    // Manual placement survives.
    expect(state.bookmark_primary_category).toHaveLength(1);
    expect(state.bookmark_primary_category[0].source).toBe('manual');
  });

  it('refuses to undo a running categorize job', async () => {
    const seed = baseSeed();
    seed.ai_jobs = [
      {
        id: 'cj1', user_id: USER, kind: 'categorize', status: 'running',
        scope: JSON.stringify({ target: 'ids', ids: ['b1'] }),
        total: 1, processed: 0, suggested: 0, failed: 0,
        engine: null, error: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        prompt_version: null,
      },
    ];
    const { env } = makeAiEnv(seed);
    await expect(undoHandler(undoCtx(env, 'cj1'))).rejects.toMatchObject({ status: 409 });
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/ai/suggestions?kind=category
 * ------------------------------------------------------------------ */

describe('GET /api/ai/suggestions — kind filter', () => {
  it('returns only category suggestions when kind=category', async () => {
    const seed = baseSeed();
    seed.tag_suggestions = [
      {
        id: 'ts1', user_id: USER, bookmark_id: 'b1', job_id: 'j1',
        tag_name: 'React', tag_id: null, confidence: 0.8,
        source: 'model', reason: null, kind: 'tag',
        status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'cs1', user_id: USER, bookmark_id: 'b2', job_id: 'j2',
        tag_name: '开发技术 > 前端开发', tag_id: 'fe', confidence: 0.9,
        source: 'model', reason: null, kind: 'category',
        status: 'pending', decided_at: null, created_at: '2026-01-02T00:00:00Z',
      },
    ];
    const { env } = makeAiEnv(seed);

    const res = await suggestionsHandler(suggestionsCtx(env, '?kind=category'));
    const body = (await res.json()) as { suggestions: Array<{ id: string; kind: string; category: string | null; subcategory: string | null }> };

    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].id).toBe('cs1');
    expect(body.suggestions[0].kind).toBe('category');
    // Category path is split from tagName.
    expect(body.suggestions[0].category).toBe('开发技术');
    expect(body.suggestions[0].subcategory).toBe('前端开发');
  });

  it('returns both kinds when no kind param', async () => {
    const seed = baseSeed();
    seed.tag_suggestions = [
      {
        id: 'ts1', user_id: USER, bookmark_id: 'b1', job_id: 'j1',
        tag_name: 'React', tag_id: null, confidence: 0.8,
        source: 'model', reason: null, kind: 'tag',
        status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'cs1', user_id: USER, bookmark_id: 'b2', job_id: 'j2',
        tag_name: '开发技术 > 前端开发', tag_id: 'fe', confidence: 0.9,
        source: 'model', reason: null, kind: 'category',
        status: 'pending', decided_at: null, created_at: '2026-01-02T00:00:00Z',
      },
    ];
    const { env } = makeAiEnv(seed);

    const res = await suggestionsHandler(suggestionsCtx(env));
    const body = (await res.json()) as { suggestions: Array<{ id: string }> };
    expect(body.suggestions).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * POST /api/ai/suggestions/apply — kind='category'
 * ------------------------------------------------------------------ */

describe('POST /api/ai/suggestions/apply — category', () => {
  it('accepts a category suggestion and writes placement', async () => {
    const seed = baseSeed();
    seed.tag_suggestions = [
      {
        id: 'cs1', user_id: USER, bookmark_id: 'b1', job_id: 'cj1',
        tag_name: '开发技术 > 前端开发', tag_id: 'fe', confidence: 0.9,
        source: 'model', reason: null, kind: 'category',
        status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
      },
    ];
    const { env, state } = makeAiEnv(seed);

    const res = await applyHandler(applyCtx(env, { action: 'accept', ids: ['cs1'], kind: 'category' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number; rejected: number; tagsCreated: number };
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);

    // Placement written.
    expect(state.bookmark_primary_category).toHaveLength(1);
    expect(state.bookmark_primary_category[0].bookmark_id).toBe('b1');
    expect(state.bookmark_primary_category[0].source).toBe('ai');

    // Suggestion marked accepted.
    expect(state.tag_suggestions[0].status).toBe('accepted');
  });

  it('rejects a category suggestion without writing placement', async () => {
    const seed = baseSeed();
    seed.tag_suggestions = [
      {
        id: 'cs1', user_id: USER, bookmark_id: 'b1', job_id: 'cj1',
        tag_name: '开发技术 > 前端开发', tag_id: 'fe', confidence: 0.9,
        source: 'model', reason: null, kind: 'category',
        status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
      },
    ];
    const { env, state } = makeAiEnv(seed);

    const res = await applyHandler(applyCtx(env, { action: 'reject', ids: ['cs1'], kind: 'category' }));
    const body = (await res.json()) as { accepted: number; rejected: number };
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);

    // No placement written.
    expect(state.bookmark_primary_category).toHaveLength(0);
    expect(state.tag_suggestions[0].status).toBe('rejected');
  });

  it('bulk apply by jobId only touches category suggestions', async () => {
    const seed = baseSeed();
    seed.tag_suggestions = [
      {
        id: 'cs1', user_id: USER, bookmark_id: 'b1', job_id: 'cj1',
        tag_name: '开发技术 > 前端开发', tag_id: 'fe', confidence: 0.9,
        source: 'model', reason: null, kind: 'category',
        status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'ts1', user_id: USER, bookmark_id: 'b2', job_id: 'cj1',
        tag_name: 'React', tag_id: null, confidence: 0.8,
        source: 'model', reason: null, kind: 'tag',
        status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
      },
    ];
    const { env, state } = makeAiEnv(seed);

    // Apply all category suggestions for job cj1.
    const res = await applyHandler(applyCtx(env, { action: 'accept', jobId: 'cj1', kind: 'category' }));
    const body = (await res.json()) as { accepted: number };
    expect(body.accepted).toBe(1);

    // Only the category suggestion was accepted; the tag suggestion stays pending.
    expect(state.tag_suggestions.find((s) => s.id === 'cs1')!.status).toBe('accepted');
    expect(state.tag_suggestions.find((s) => s.id === 'ts1')!.status).toBe('pending');
  });

  it('rejects empty ids with kind-specific message', async () => {
    const { env } = makeAiEnv(baseSeed());
    await expect(
      applyHandler(applyCtx(env, { action: 'accept', ids: [], kind: 'category' })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

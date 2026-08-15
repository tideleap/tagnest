import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { undoJob } from '../functions/_lib/ai/store';
import { onRequestPost as undoHandler } from '../functions/api/ai/jobs/[id]/undo';
import { createAiDb, type AiDbState } from './helpers/aiDb';
import { MockDb, makeEnv } from './_support/dbMock';

/**
 * Undo tests (plan T2 "可撤销"). The contract under test:
 *  - only `source = 'ai'` links traceable to the job's ACCEPTED suggestions
 *    are removed — user tags and other jobs' links survive;
 *  - accepted suggestions return to the review queue (pending);
 *  - unless a newer pending proposal already covers the same (bookmark, tag),
 *    in which case the stale accepted row is dropped instead of revived
 *    (the one-pending-per-(bookmark, tag) unique index must hold).
 */

function makeAiEnv(seed?: Partial<AiDbState>): { env: Env; state: AiDbState } {
  const { db, state } = createAiDb(seed);
  return { env: { DB: db as never } as unknown as Env, state };
}

/** One accepted suggestion (job j1, tag 前端) plus the AI link it produced. */
function basicSeed(): AiDbState {
  return {
    tags: [
      { id: 'fe', user_id: 'u1', name: '前端', color_index: 0, parent_id: null, sort_order: 0, created_at: '2026' },
      { id: 'be', user_id: 'u1', name: '后端', color_index: 1, parent_id: null, sort_order: 1, created_at: '2026' },
    ],
    bookmarks: [
      { id: 'b1', user_id: 'u1', url: 'https://a.com', title: 'A', description: null, deleted_at: null, ai_summary: null, created_at: '2026' },
    ],
    tag_suggestions: [
      { id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1', tag_name: '前端', tag_id: 'fe', confidence: 0.9, source: 'model', reason: 'r', status: 'accepted' as const, decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    ],
    bookmark_tags: [
      { bookmark_id: 'b1', tag_id: 'fe', source: 'ai', confidence: 0.9, created_at: '2026-02-01T00:00:00Z' },
    ],
    ai_jobs: [],
    ai_feedback: [],
    ai_settings: [],
  };
}

describe('undoJob — store level', () => {
  it('removes the AI link and returns the suggestion to the queue', async () => {
    const { env, state } = makeAiEnv(basicSeed());
    const outcome = await undoJob(env, 'u1', 'j1');
    expect(outcome).toEqual({ removedLinks: 1, restoredSuggestions: 1, droppedSuggestions: 0 });
    expect(state.bookmark_tags).toHaveLength(0);
    const s = state.tag_suggestions.find((x) => x.id === 's1');
    expect(s?.status).toBe('pending');
    expect(s?.decided_at).toBeNull();
  });

  it('never touches user-applied tags', async () => {
    const seed = basicSeed();
    // The same (bookmark, tag) pair, but applied by the user — source='user'
    // must survive even though an accepted suggestion matches it.
    seed.bookmark_tags = [
      { bookmark_id: 'b1', tag_id: 'fe', source: 'user', confidence: null, created_at: '2026-02-01T00:00:00Z' },
      // A genuine AI link on a different tag, to prove the delete still works.
      { bookmark_id: 'b1', tag_id: 'be', source: 'ai', confidence: 0.8, created_at: '2026-02-01T00:00:00Z' },
    ];
    seed.tag_suggestions.push({
      id: 's2', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1', tag_name: '后端', tag_id: 'be',
      confidence: 0.8, source: 'model', reason: 'r', status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
    });
    const { env, state } = makeAiEnv(seed);
    const outcome = await undoJob(env, 'u1', 'j1');
    // Only the 'ai' link goes; the user's 前端 tag stays.
    expect(outcome.removedLinks).toBe(1);
    expect(state.bookmark_tags).toHaveLength(1);
    expect(state.bookmark_tags[0].source).toBe('user');
    expect(state.bookmark_tags[0].tag_id).toBe('fe');
  });

  it('leaves other jobs’ accepted work alone', async () => {
    const seed = basicSeed();
    seed.tag_suggestions.push({
      id: 's2', user_id: 'u1', bookmark_id: 'b1', job_id: 'j2', tag_name: '后端', tag_id: 'be',
      confidence: 0.8, source: 'model', reason: 'r', status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-02T00:00:00Z',
    });
    seed.bookmark_tags.push({
      bookmark_id: 'b1', tag_id: 'be', source: 'ai', confidence: 0.8, created_at: '2026-02-01T00:00:00Z',
    });
    const { env, state } = makeAiEnv(seed);
    const outcome = await undoJob(env, 'u1', 'j1');
    expect(outcome.removedLinks).toBe(1);
    // j2's link and suggestion are untouched.
    expect(state.bookmark_tags.map((bt) => bt.tag_id)).toEqual(['be']);
    expect(state.tag_suggestions.find((x) => x.id === 's2')?.status).toBe('accepted');
  });

  it('drops a stale accepted row when a newer pending proposal supersedes it', async () => {
    const seed = basicSeed();
    // A later run re-proposed the same (bookmark, tag): reviving the old
    // accepted row would break the one-pending-per-(bookmark, tag) index.
    seed.tag_suggestions.push({
      id: 's2', user_id: 'u1', bookmark_id: 'b1', job_id: 'j2', tag_name: '前端', tag_id: 'fe',
      confidence: 0.7, source: 'model', reason: 'r', status: 'pending', decided_at: null, created_at: '2026-03-01T00:00:00Z',
    });
    const { env, state } = makeAiEnv(seed);
    const outcome = await undoJob(env, 'u1', 'j1');
    // The link still traces back to j1's accepted suggestion, so it goes.
    expect(outcome.removedLinks).toBe(1);
    expect(outcome.restoredSuggestions).toBe(0);
    expect(outcome.droppedSuggestions).toBe(1);
    // Only the fresh pending proposal remains.
    expect(state.tag_suggestions).toHaveLength(1);
    expect(state.tag_suggestions[0].id).toBe('s2');
    expect(state.tag_suggestions[0].status).toBe('pending');
  });

  it('matches tag names case-insensitively', async () => {
    const seed = basicSeed();
    seed.tags = [
      { id: 'fe', user_id: 'u1', name: 'Frontend', color_index: 0, parent_id: null, sort_order: 0, created_at: '2026' },
    ];
    seed.tag_suggestions = [
      { id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1', tag_name: 'frontend', tag_id: 'fe', confidence: 0.9, source: 'model', reason: 'r', status: 'accepted' as const, decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    ];
    const { env } = makeAiEnv(seed);
    const outcome = await undoJob(env, 'u1', 'j1');
    expect(outcome.removedLinks).toBe(1);
  });

  it('is a no-op for a job with no accepted suggestions', async () => {
    const seed = basicSeed();
    seed.tag_suggestions = [];
    seed.bookmark_tags = [
      { bookmark_id: 'b1', tag_id: 'fe', source: 'ai', confidence: 0.9, created_at: '2026' },
    ];
    const { env, state } = makeAiEnv(seed);
    const outcome = await undoJob(env, 'u1', 'j1');
    expect(outcome).toEqual({ removedLinks: 0, restoredSuggestions: 0, droppedSuggestions: 0 });
    // Untraceable AI link (no accepted suggestion) is left for manual review —
    // undo must never delete more than it can attribute.
    expect(state.bookmark_tags).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * POST /api/ai/jobs/:id/undo
 * ------------------------------------------------------------------ */

function ctx(env: Env, userId: string, id: string) {
  return {
    request: new Request(`https://tagnest.test/api/ai/jobs/${id}/undo`, { method: 'POST' }),
    env,
    data: { userId },
    params: { id },
  } as unknown as Parameters<typeof undoHandler>[0];
}

function pushJob(db: MockDb, over: Record<string, unknown> = {}) {
  db.ai_jobs.push({
    id: 'j1',
    user_id: 'u1',
    kind: 'tagging',
    status: 'done',
    scope: JSON.stringify({ target: 'untagged', ids: ['b1'] }),
    total: 1,
    processed: 1,
    suggested: 1,
    failed: 0,
    engine: 'model',
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    prompt_version: null,
    ...over,
  });
}

function seedAcceptedWork(db: MockDb) {
  db.tags.push({ id: 'fe', user_id: 'u1', name: '前端', is_private: 0 });
  db.tag_suggestions.push({
    id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1', tag_name: '前端', tag_id: 'fe',
    confidence: 0.9, source: 'model', status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
  });
  db.bookmark_tags.push({ bookmark_id: 'b1', tag_id: 'fe', source: 'ai', confidence: 0.9 });
}

describe('POST /api/ai/jobs/:id/undo', () => {
  it('undoes a settled run and reports the outcome', async () => {
    const env = makeEnv({ LOG_LEVEL: 'error' });
    const db = env.DB as MockDb;
    pushJob(db);
    seedAcceptedWork(db);

    const res = await undoHandler(ctx(env, 'u1', 'j1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      job: { id: string; status: string };
      removedLinks: number;
      restoredSuggestions: number;
      droppedSuggestions: number;
    };
    expect(body.job.id).toBe('j1');
    expect(body.removedLinks).toBe(1);
    expect(body.restoredSuggestions).toBe(1);
    expect(body.droppedSuggestions).toBe(0);
    expect(db.bookmark_tags).toHaveLength(0);
    expect(db.tag_suggestions[0].status).toBe('pending');
  });

  it('refuses to undo a run that is still active (409)', async () => {
    const env = makeEnv({ LOG_LEVEL: 'error' });
    const db = env.DB as MockDb;
    pushJob(db, { status: 'running' });
    seedAcceptedWork(db);

    await expect(undoHandler(ctx(env, 'u1', 'j1'))).rejects.toMatchObject({ status: 409 });
    // Nothing was undone.
    expect(db.bookmark_tags).toHaveLength(1);
    expect(db.tag_suggestions[0].status).toBe('accepted');
  });

  it('returns 404 for an unknown job', async () => {
    const env = makeEnv({ LOG_LEVEL: 'error' });
    await expect(undoHandler(ctx(env, 'u1', 'nope'))).rejects.toMatchObject({ status: 404 });
  });

  it('cannot undo another user’s job', async () => {
    const env = makeEnv({ LOG_LEVEL: 'error' });
    const db = env.DB as MockDb;
    pushJob(db, { user_id: 'other' });
    await expect(undoHandler(ctx(env, 'u1', 'j1'))).rejects.toMatchObject({ status: 404 });
  });
});

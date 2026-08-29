import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import {
  decideRenameSuggestions,
  saveRenameSuggestions,
  undoRenameJob,
} from '../functions/_lib/ai/store';
import type { RenameResult } from '../functions/_lib/ai/engine';
import { createAiDb, type AiDbState } from './helpers/aiDb';

/**
 * Rename store tests (structured-organise Phase B). The contract under test:
 *  - save stores the NEW title in tag_name and the ORIGINAL in topic, one
 *    pending row per bookmark, deduped against the live title;
 *  - accept rewrites bookmarks.title only when the live title still matches
 *    the original (the user's edit wins); reject just marks the row;
 *  - undo restores the original title only when the live title still matches
 *    the accepted proposal (never clobbering a manual edit) and requeues the
 *    accepted suggestions.
 */

function makeAiEnv(seed?: Partial<AiDbState>): { env: Env; state: AiDbState } {
  const { db, state } = createAiDb(seed);
  return { env: { DB: db as never } as unknown as Env, state };
}

/** One bookmark + one rename candidate for it. */
function basicSeed(): AiDbState {
  return {
    bookmarks: [
      {
        id: 'b1',
        user_id: 'u1',
        url: 'https://github.com/',
        title: 'GitHub · Where the world builds software',
        description: null,
        deleted_at: null,
        ai_summary: null,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'b2',
        user_id: 'u1',
        url: 'https://vitejs.dev/',
        title: '首页',
        description: null,
        deleted_at: null,
        ai_summary: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    tag_suggestions: [],
    ai_jobs: [],
    ai_feedback: [],
    ai_settings: [],
    bookmark_tags: [],
    tags: [],
    bookmark_primary_category: [],
  };
}

function candidate(bookmarkId: string, original: string, title: string, reason = 'r'): RenameResult {
  return { bookmarkId, rename: { original, title, reason } };
}

describe('saveRenameSuggestions', () => {
  it('stores the new title in tag_name and the original in topic', async () => {
    const { env, state } = makeAiEnv(basicSeed());
    const written = await saveRenameSuggestions(env, 'u1', 'j1', [
      candidate('b1', 'GitHub · Where the world builds software', 'GitHub'),
      candidate('b2', '首页', 'Vite：下一代前端构建工具'),
    ]);
    expect(written).toBe(2);
    expect(state.tag_suggestions).toHaveLength(2);
    const b1 = state.tag_suggestions.find((s) => s.bookmark_id === 'b1');
    expect(b1).toMatchObject({
      tag_name: 'GitHub',
      topic: 'GitHub · Where the world builds software',
      kind: 'rename',
      status: 'pending',
      source: 'model',
      tag_id: null,
    });
  });

  it('skips a bookmark whose live title already equals the proposal', async () => {
    const seed = basicSeed();
    seed.bookmarks[0].title = 'GitHub'; // edited between engine and save
    const { env, state } = makeAiEnv(seed);
    const written = await saveRenameSuggestions(env, 'u1', 'j1', [
      candidate('b1', 'GitHub · Where the world builds software', 'GitHub'),
      candidate('b2', '首页', 'Vite'),
    ]);
    expect(written).toBe(1);
    expect(state.tag_suggestions.map((s) => s.bookmark_id)).toEqual(['b2']);
  });

  it('ignores results without a rename candidate', async () => {
    const { env, state } = makeAiEnv(basicSeed());
    const written = await saveRenameSuggestions(env, 'u1', 'j1', [
      { bookmarkId: 'b1', rename: null },
    ]);
    expect(written).toBe(0);
    expect(state.tag_suggestions).toHaveLength(0);
  });

  it('replaces the previous pending proposal but keeps accepted/rejected rows', async () => {
    const seed = basicSeed();
    seed.tag_suggestions.push(
      {
        id: 'old_pending', user_id: 'u1', bookmark_id: 'b1', job_id: 'j0',
        tag_name: 'GitHub', tag_id: null, confidence: 0.9, source: 'model',
        reason: 'old', topic: 'GitHub · Old', kind: 'rename',
        status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'old_rejected', user_id: 'u1', bookmark_id: 'b1', job_id: 'j0',
        tag_name: 'GH', tag_id: null, confidence: 0.9, source: 'model',
        reason: 'rejected before', topic: 'GitHub · Old', kind: 'rename',
        status: 'rejected', decided_at: '2026-01-02T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
      },
    );
    const { env, state } = makeAiEnv(seed);
    await saveRenameSuggestions(env, 'u1', 'j1', [
      candidate('b1', 'GitHub · Where the world builds software', 'GitHub'),
    ]);
    // The stale pending row is gone; the rejected row is untouched history.
    expect(state.tag_suggestions.some((s) => s.id === 'old_pending')).toBe(false);
    expect(state.tag_suggestions.some((s) => s.id === 'old_rejected')).toBe(true);
  });

  it('never re-proposes a title the user already rejected (NOCASE guard)', async () => {
    const seed = basicSeed();
    seed.tag_suggestions.push({
      id: 'rejected_vite', user_id: 'u1', bookmark_id: 'b2', job_id: 'j0',
      tag_name: 'Vite：下一代前端构建工具', tag_id: null, confidence: 0.9, source: 'model',
      reason: 'user said no', topic: '首页', kind: 'rename',
      status: 'rejected', decided_at: '2026-01-02T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
    });
    const { env, state } = makeAiEnv(seed);
    const written = await saveRenameSuggestions(env, 'u1', 'j1', [
      candidate('b2', '首页', 'Vite：下一代前端构建工具'),
    ]);
    // written counts the intent, but the NOT EXISTS guard suppressed the row.
    expect(written).toBe(1);
    expect(state.tag_suggestions.filter((s) => s.bookmark_id === 'b2')).toHaveLength(1);
    expect(state.tag_suggestions[0].status).toBe('rejected');
  });

  it('does not touch pending proposals of other kinds', async () => {
    const seed = basicSeed();
    seed.tag_suggestions.push({
      id: 'tag_row', user_id: 'u1', bookmark_id: 'b1', job_id: 'j0',
      tag_name: '前端', tag_id: 'fe', confidence: 0.9, source: 'model',
      reason: 'r', kind: 'tag',
      status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
    });
    const { env, state } = makeAiEnv(seed);
    await saveRenameSuggestions(env, 'u1', 'j1', [
      candidate('b1', 'GitHub · Where the world builds software', 'GitHub'),
    ]);
    expect(state.tag_suggestions.some((s) => s.id === 'tag_row')).toBe(true);
  });
});

describe('decideRenameSuggestions', () => {
  async function seedPending(over: Partial<AiDbState> = {}) {
    const seed = basicSeed();
    seed.tag_suggestions.push(
      {
        id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1',
        tag_name: 'GitHub', tag_id: null, confidence: 0.9, source: 'model',
        reason: '去掉口号尾段', topic: 'GitHub · Where the world builds software', kind: 'rename',
        status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 's2', user_id: 'u1', bookmark_id: 'b2', job_id: 'j1',
        tag_name: 'Vite', tag_id: null, confidence: 0.9, source: 'model',
        reason: '无信息标题', topic: '首页', kind: 'rename',
        status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
      },
    );
    Object.assign(seed, over);
    return makeAiEnv(seed);
  }

  it('accept rewrites the bookmark title and bumps updated_at', async () => {
    const { env, state } = await seedPending();
    const out = await decideRenameSuggestions(env, 'u1', ['s1', 's2'], 'accept');
    expect(out).toEqual({ accepted: 2, rejected: 0 });
    const b1 = state.bookmarks.find((b) => b.id === 'b1');
    const b2 = state.bookmarks.find((b) => b.id === 'b2');
    expect(b1?.title).toBe('GitHub');
    expect(b2?.title).toBe('Vite');
    expect(b1?.updated_at).toBeTruthy();
    // Suggestions settle as accepted.
    expect(state.tag_suggestions.every((s) => s.status === 'accepted')).toBe(true);
  });

  it('accept records a modified-feedback event keyed by the original title', async () => {
    const { env, state } = await seedPending();
    await decideRenameSuggestions(env, 'u1', ['s1'], 'accept');
    expect(state.ai_feedback).toHaveLength(1);
    expect(state.ai_feedback[0]).toMatchObject({
      bookmark_id: 'b1',
      tag_name: 'rename:GitHub · Where the world builds software',
      action: 'modified',
      domain: 'github.com',
    });
  });

  it('accept skips a row whose live title no longer matches the original', async () => {
    const seed = basicSeed();
    // The user edited b2's title while the proposal sat in the queue.
    seed.bookmarks.find((b) => b.id === 'b2')!.title = 'Vite 官方指南（手改）';
    const { env, state } = makeAiEnv(seed);
    seed.tag_suggestions.push({
      id: 's2', user_id: 'u1', bookmark_id: 'b2', job_id: 'j1',
      tag_name: 'Vite', tag_id: null, confidence: 0.9, source: 'model',
      reason: '无信息标题', topic: '首页', kind: 'rename',
      status: 'pending', decided_at: null, created_at: '2026-01-01T00:00:00Z',
    });
    const out = await decideRenameSuggestions(env, 'u1', ['s2'], 'accept');
    // The proposal is marked accepted (it was decided) but no title was written.
    expect(out.accepted).toBe(0);
    expect(state.bookmarks.find((b) => b.id === 'b2')?.title).toBe('Vite 官方指南（手改）');
  });

  it('reject marks the rows without touching any title', async () => {
    const { env, state } = await seedPending();
    const out = await decideRenameSuggestions(env, 'u1', ['s1'], 'reject');
    expect(out).toEqual({ accepted: 0, rejected: 1 });
    expect(state.bookmarks.find((b) => b.id === 'b1')?.title).toBe('GitHub · Where the world builds software');
    expect(state.tag_suggestions.find((s) => s.id === 's1')?.status).toBe('rejected');
    // Rejection produces no feedback events.
    expect(state.ai_feedback).toHaveLength(0);
  });

  it('is a no-op for unknown or already-decided ids', async () => {
    const { env, state } = await seedPending();
    const first = await decideRenameSuggestions(env, 'u1', ['s1'], 'accept');
    expect(first.accepted).toBe(1);
    const second = await decideRenameSuggestions(env, 'u1', ['s1', 'ghost'], 'accept');
    expect(second).toEqual({ accepted: 0, rejected: 0 });
    // No feedback was recorded for the replay.
    expect(state.ai_feedback).toHaveLength(1);
  });

  it('never writes titles for another user', async () => {
    const { env, state } = await seedPending();
    const out = await decideRenameSuggestions(env, 'someone-else', ['s1'], 'accept');
    expect(out).toEqual({ accepted: 0, rejected: 0 });
    expect(state.bookmarks.find((b) => b.id === 'b1')?.title).not.toBe('GitHub');
  });
});

describe('undoRenameJob', () => {
  async function seedAccepted() {
    const seed = basicSeed();
    seed.bookmarks.find((b) => b.id === 'b1')!.title = 'GitHub';
    seed.bookmarks.find((b) => b.id === 'b2')!.title = 'Vite';
    seed.tag_suggestions.push(
      {
        id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1',
        tag_name: 'GitHub', tag_id: null, confidence: 0.9, source: 'model',
        reason: 'r', topic: 'GitHub · Where the world builds software', kind: 'rename',
        status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 's2', user_id: 'u1', bookmark_id: 'b2', job_id: 'j1',
        tag_name: 'Vite', tag_id: null, confidence: 0.9, source: 'model',
        reason: 'r', topic: '首页', kind: 'rename',
        status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
      },
    );
    return makeAiEnv(seed);
  }

  it('restores original titles and requeues the accepted suggestions', async () => {
    const { env, state } = await seedAccepted();
    const out = await undoRenameJob(env, 'u1', 'j1');
    expect(out).toEqual({ restoredTitles: 2, restoredSuggestions: 2 });
    expect(state.bookmarks.find((b) => b.id === 'b1')?.title).toBe('GitHub · Where the world builds software');
    expect(state.bookmarks.find((b) => b.id === 'b2')?.title).toBe('首页');
    expect(state.tag_suggestions.every((s) => s.status === 'pending' && s.decided_at === null)).toBe(true);
  });

  it('never clobbers a manual edit made after accepting', async () => {
    const seed = basicSeed();
    // b1 still shows the accepted title → restorable; b2 was hand-edited → protected.
    seed.bookmarks.find((b) => b.id === 'b1')!.title = 'GitHub';
    seed.bookmarks.find((b) => b.id === 'b2')!.title = 'Vite 官方指南（手改）';
    seed.tag_suggestions.push(
      {
        id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1',
        tag_name: 'GitHub', tag_id: null, confidence: 0.9, source: 'model',
        reason: 'r', topic: 'GitHub · Old', kind: 'rename',
        status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 's2', user_id: 'u1', bookmark_id: 'b2', job_id: 'j1',
        tag_name: 'Vite', tag_id: null, confidence: 0.9, source: 'model',
        reason: 'r', topic: '首页', kind: 'rename',
        status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
      },
    );
    const { env, state } = makeAiEnv(seed);
    const out = await undoRenameJob(env, 'u1', 'j1');
    expect(out.restoredTitles).toBe(1);
    expect(state.bookmarks.find((b) => b.id === 'b1')?.title).toBe('GitHub · Old');
    expect(state.bookmarks.find((b) => b.id === 'b2')?.title).toBe('Vite 官方指南（手改）');
    // Both rows requeue — the decision was undone either way.
    expect(state.tag_suggestions.every((s) => s.status === 'pending')).toBe(true);
  });

  it('leaves other jobs’ accepted renames alone', async () => {
    const seed = basicSeed();
    // Both accepts already happened: b1 → GitHub (j1), b2 → Vite (j2).
    seed.bookmarks.find((b) => b.id === 'b1')!.title = 'GitHub';
    seed.bookmarks.find((b) => b.id === 'b2')!.title = 'Vite';
    seed.tag_suggestions.push(
      {
        id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1',
        tag_name: 'GitHub', tag_id: null, confidence: 0.9, source: 'model',
        reason: 'r', topic: 'GitHub · Old', kind: 'rename',
        status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 's2', user_id: 'u1', bookmark_id: 'b2', job_id: 'j2',
        tag_name: 'Vite', tag_id: null, confidence: 0.9, source: 'model',
        reason: 'r', topic: '首页', kind: 'rename',
        status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-02T00:00:00Z',
      },
    );
    const { env, state } = makeAiEnv(seed);
    const out = await undoRenameJob(env, 'u1', 'j1');
    expect(out.restoredTitles).toBe(1);
    expect(state.bookmarks.find((b) => b.id === 'b1')?.title).toBe('GitHub · Old');
    expect(state.bookmarks.find((b) => b.id === 'b2')?.title).toBe('Vite');
    expect(state.tag_suggestions.find((s) => s.id === 's2')?.status).toBe('accepted');
  });

  it('only undoes rename rows — tag/category suggestions of the same job survive', async () => {
    const seed = basicSeed();
    seed.bookmarks.find((b) => b.id === 'b1')!.title = 'GitHub';
    seed.tag_suggestions.push(
      {
        id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1',
        tag_name: 'GitHub', tag_id: null, confidence: 0.9, source: 'model',
        reason: 'r', topic: 'GitHub · Old', kind: 'rename',
        status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'tag1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1',
        tag_name: '前端', tag_id: 'fe', confidence: 0.9, source: 'model',
        reason: 'r', kind: 'tag',
        status: 'accepted', decided_at: '2026-02-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
      },
    );
    const { env, state } = makeAiEnv(seed);
    const out = await undoRenameJob(env, 'u1', 'j1');
    expect(out.restoredSuggestions).toBe(1);
    expect(state.tag_suggestions.find((s) => s.id === 'tag1')?.status).toBe('accepted');
  });

  it('is a no-op for a job with no accepted renames', async () => {
    const { env } = await seedAccepted();
    const out = await undoRenameJob(env, 'u1', 'nope');
    expect(out).toEqual({ restoredTitles: 0, restoredSuggestions: 0 });
  });
});

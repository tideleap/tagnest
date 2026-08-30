import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import type { SuggestionResult } from '../functions/_lib/ai/engine';
import {
  autoApply,
  countPending,
  createJob,
  decideSuggestions,
  getJob,
  incrementJobCounters,
  listJobs,
  listPendingSuggestions,
  resolveScope,
  saveSuggestions,
  updateJob,
} from '../functions/_lib/ai/store';
import { createAiDb, type AiDbState, type BookmarkRow, type SuggestionRow } from './helpers/aiDb';

function makeEnv(seed?: Partial<AiDbState>): { env: Env; state: AiDbState } {
  const { db, state } = createAiDb(seed);
  return { env: { DB: db as never }, state };
}

describe('saveSuggestions — write-once, attribute everything', () => {
  it('stores attributed, pending suggestions and a summary', async () => {
    const { env, state } = makeEnv({
      bookmarks: [
        { id: 'b1', user_id: 'u1', url: 'https://a.com', title: 'A', description: null, deleted_at: null, ai_summary: null, created_at: '2024' },
      ],
    });

    const results: SuggestionResult[] = [
      {
        bookmarkId: 'b1',
        summary: '摘要内容',
        topic: '前端框架',
        needsReview: true,
        tags: [
          { name: '前端', tagId: 'fe', confidence: 0.9, source: 'model', reason: 'r1' },
          { name: '后端', tagId: null, confidence: 0.8, source: 'fallback', reason: 'r2' },
        ],
      },
    ];

    const written = await saveSuggestions(env, 'u1', 'j1', results);
    expect(written).toBe(2);
    expect(state.tag_suggestions).toHaveLength(2);
    expect(state.tag_suggestions.every((s) => s.status === 'pending')).toBe(true);
    expect(state.tag_suggestions.map((s) => s.source).sort()).toEqual(['fallback', 'model']);
    // The per-bookmark topic + review flag ride along on every tag row so the
    // query can surface them grouped by bookmark.
    expect(state.tag_suggestions.every((s) => s.topic === '前端框架')).toBe(true);
    expect(state.tag_suggestions.every((s) => s.needs_review === 1)).toBe(true);
    expect(state.bookmarks[0].ai_summary).toBe('摘要内容');
  });

  it('refreshes instead of stacking on re-run', async () => {
    const { env, state } = makeEnv({
      bookmarks: [{ id: 'b1', user_id: 'u1', url: 'https://a.com', title: 'A', description: null, deleted_at: null, ai_summary: null, created_at: '2024' }],
    });
    const base: SuggestionResult[] = [
      { bookmarkId: 'b1', summary: null, tags: [{ name: '前端', tagId: 'fe', confidence: 0.9, source: 'model', reason: 'r' }] },
    ];
    await saveSuggestions(env, 'u1', 'j1', base);
    await saveSuggestions(env, 'u1', 'j1', base);
    // Delete-then-insert means a re-run replaces the proposal, it does not stack.
    expect(state.tag_suggestions.filter((s) => s.bookmark_id === 'b1' && s.status === 'pending')).toHaveLength(1);
  });

  it('does not suggest a tag the bookmark already carries', async () => {
    const { env, state } = makeEnv({
      bookmarks: [{ id: 'b1', user_id: 'u1', url: 'https://a.com', title: 'A', description: null, deleted_at: null, ai_summary: null, created_at: '2024' }],
      bookmark_tags: [{ bookmark_id: 'b1', tag_id: 'fe', source: 'user', confidence: null, created_at: '2024' }],
    });
    const results: SuggestionResult[] = [
      { bookmarkId: 'b1', summary: null, tags: [
        { name: '前端', tagId: 'fe', confidence: 0.9, source: 'model', reason: 'r' },
        { name: '后端', tagId: null, confidence: 0.8, source: 'fallback', reason: 'r' },
      ] },
    ];
    await saveSuggestions(env, 'u1', 'j1', results);
    // 前端 is skipped (already tagged), 后端 is inserted.
    const pending = state.tag_suggestions.filter((s) => s.bookmark_id === 'b1');
    expect(pending.map((s) => s.tag_name)).toEqual(['后端']);
  });

  it('does not re-propose a previously rejected tag', async () => {
    const { env, state } = makeEnv({
      bookmarks: [{ id: 'b1', user_id: 'u1', url: 'https://a.com', title: 'A', description: null, deleted_at: null, ai_summary: null, created_at: '2024' }],
      tag_suggestions: [
        { id: 'old', user_id: 'u1', bookmark_id: 'b1', job_id: 'j0', tag_name: '设计', tag_id: null, confidence: 0.6, source: 'model', reason: 'r', status: 'rejected', decided_at: '2024', created_at: '2024' },
      ],
    });
    const results: SuggestionResult[] = [
      { bookmarkId: 'b1', summary: null, tags: [{ name: '设计', tagId: null, confidence: 0.6, source: 'model', reason: 'r' }] },
    ];
    await saveSuggestions(env, 'u1', 'j1', results);
    const pending = state.tag_suggestions.filter((s) => s.bookmark_id === 'b1' && s.status === 'pending');
    expect(pending).toHaveLength(0);
  });
});

describe('decideSuggestions — accept / reject with attribution', () => {
  // A factory, not a shared constant: decideSuggestions mutates the seeded rows
  // in place, and adjacent tests must not see each other's leftovers.
  function orgSeed(): AiDbState {
    return {
      tags: [
        { id: 'fe', user_id: 'u1', name: '前端', color_index: 0, parent_id: null, sort_order: 0, created_at: '2024' },
      ],
      bookmarks: [
        { id: 'b1', user_id: 'u1', url: 'https://a.com', title: 'A', description: null, deleted_at: null, ai_summary: null, created_at: '2024' },
      ],
      tag_suggestions: [
        { id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1', tag_name: '前端', tag_id: 'fe', confidence: 0.9, source: 'model', reason: 'r', status: 'pending' as const, decided_at: null, created_at: '2024' },
        { id: 's2', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1', tag_name: '后端', tag_id: null, confidence: 0.8, source: 'fallback', reason: 'r', status: 'pending' as const, decided_at: null, created_at: '2024' },
      ],
      bookmark_tags: [],
      ai_jobs: [],
      ai_settings: [],
    };
  }

  it('accepts: writes bookmark_tags with source="ai" and creates a new tag', async () => {
    const { env, state } = makeEnv(orgSeed());
    const out = await decideSuggestions(env, 'u1', ['s1', 's2'], 'accept');
    expect(out.accepted).toBe(2);
    expect(out.tagsCreated).toBe(1); // 后端 did not exist yet
    expect(state.bookmark_tags).toHaveLength(2);
    expect(state.bookmark_tags.every((bt) => bt.source === 'ai')).toBe(true);
    // confidence is recorded so contribution stats are possible later.
    expect(state.bookmark_tags.find((bt) => bt.tag_id === 'fe')?.confidence).toBe(0.9);
    // the suggestion rows are now accepted.
    expect(state.tag_suggestions.filter((s) => s.status === 'accepted')).toHaveLength(2);
    // a real "后端" tag now exists.
    expect(state.tags.some((t) => t.name === '后端')).toBe(true);
  });

  it('rejects: marks rows and writes nothing to bookmark_tags', async () => {
    const { env, state } = makeEnv(orgSeed());
    const before = state.bookmark_tags.length;
    const out = await decideSuggestions(env, 'u1', ['s1'], 'reject');
    expect(out.rejected).toBe(1);
    expect(out.accepted).toBe(0);
    expect(state.bookmark_tags.length).toBe(before);
    expect(state.tag_suggestions.find((s) => s.id === 's1')?.status).toBe('rejected');
  });

  it('ignores ids that are no longer pending', async () => {
    const { env, state } = makeEnv(orgSeed());
    await decideSuggestions(env, 'u1', ['s1'], 'reject');
    // A second accept of the now-rejected id must be a no-op.
    const out = await decideSuggestions(env, 'u1', ['s1'], 'accept');
    expect(out.accepted).toBe(0);
    expect(state.bookmark_tags).toHaveLength(0);
  });

  it('accepts a whole run (130 suggestions) without losing any', async () => {
    // Regression: the writes used to all go into a single env.DB.batch() call.
    // D1 caps a batch at 100 statements, so a full run of 130+ suggestions
    // exceeded the cap and surfaced to the UI as "服务器内部错误". The inserts
    // are now flushed in groups of 90 with the status flip last.
    const N = 130;
    const bookmarks: BookmarkRow[] = [];
    const suggestions: SuggestionRow[] = [];
    for (let i = 0; i < N; i += 1) {
      const bid = `b${i}`;
      bookmarks.push({
        id: bid,
        user_id: 'u1',
        url: `https://site${i}.com`,
        title: `Site ${i}`,
        description: null,
        deleted_at: null,
        ai_summary: null,
        created_at: '2024',
      });
      suggestions.push({
        id: `s${i}`,
        user_id: 'u1',
        bookmark_id: bid,
        job_id: 'j1',
        tag_name: `标签${i}`,
        tag_id: null,
        confidence: 0.7 + (i % 30) * 0.01,
        source: 'model',
        reason: 'r',
        status: 'pending',
        decided_at: null,
        created_at: '2024',
      });
    }

    const { env, state } = makeEnv({ bookmarks, tag_suggestions: suggestions });
    const ids = suggestions.map((s) => s.id);
    const out = await decideSuggestions(env, 'u1', ids, 'accept');

    expect(out.accepted).toBe(N);
    expect(out.tagsCreated).toBe(N); // every proposal was a brand-new tag
    expect(state.bookmark_tags).toHaveLength(N);
    expect(state.bookmark_tags.every((bt) => bt.source === 'ai')).toBe(true);
    expect(state.tag_suggestions.filter((s) => s.status === 'accepted')).toHaveLength(N);
  });
});

describe('autoApply — high-confidence skip-review path', () => {
  const seed = {
    bookmarks: [
      { id: 'b1', user_id: 'u1', url: 'https://a.com/1', title: 'A', description: null, deleted_at: null, ai_summary: null, created_at: '2024' },
      { id: 'b2', user_id: 'u1', url: 'https://a.com/2', title: 'B', description: null, deleted_at: null, ai_summary: null, created_at: '2024' },
    ],
    tag_suggestions: [
      { id: 'hi', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1', tag_name: '前端', tag_id: 'fe', confidence: 0.9, source: 'model', reason: 'r', status: 'pending' as const, decided_at: null, created_at: '2024' },
      { id: 'lo', user_id: 'u1', bookmark_id: 'b2', job_id: 'j1', tag_name: '后端', tag_id: null, confidence: 0.5, source: 'fallback', reason: 'r', status: 'pending' as const, decided_at: null, created_at: '2024' },
    ],
  };

  it('applies only suggestions at or above the threshold', async () => {
    const { env, state } = makeEnv(seed);
    const applied = await autoApply(env, 'u1', 0.7, 'j1');
    expect(applied).toBe(1);
    expect(state.tag_suggestions.find((s) => s.id === 'hi')?.status).toBe('accepted');
    expect(state.tag_suggestions.find((s) => s.id === 'lo')?.status).toBe('pending');
    expect(state.bookmark_tags).toHaveLength(1);
  });

  it('does nothing when the threshold is at the ceiling', async () => {
    const { env } = makeEnv(seed);
    expect(await autoApply(env, 'u1', 1, 'j1')).toBe(0);
  });
});

describe('countPending / listPendingSuggestions', () => {
  it('counts and joins review rows with bookmark context', async () => {
    const { env, state } = makeEnv({
      bookmarks: [
        { id: 'b1', user_id: 'u1', url: 'https://a.com', title: '我的页面', description: null, deleted_at: null, ai_summary: null, created_at: '2024' },
      ],
      tag_suggestions: [
        { id: 's1', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1', tag_name: '前端', tag_id: 'fe', confidence: 0.9, source: 'model', reason: 'r', topic: '前端框架', needs_review: 1, status: 'pending' as const, decided_at: null, created_at: '2024' },
      ],
    });
    expect(await countPending(env, 'u1')).toBe(1);
    const rows = await listPendingSuggestions(env, 'u1');
    expect(rows[0].bookmarkTitle).toBe('我的页面');
    expect(rows[0].bookmarkUrl).toBe('https://a.com');
    expect(rows[0].topic).toBe('前端框架');
    expect(rows[0].needsReview).toBe(true);
    expect(state.tag_suggestions).toHaveLength(1);
  });
});

describe('resolveScope — snapshot the work set', () => {
  const seed = {
    bookmarks: [
      { id: 'b1', user_id: 'u1', url: 'https://a.com/1', title: 'A', description: null, deleted_at: null, ai_summary: null, created_at: '2024-01-01' },
      { id: 'b2', user_id: 'u1', url: 'https://a.com/2', title: 'B', description: null, deleted_at: null, ai_summary: null, created_at: '2024-02-01' },
    ],
    bookmark_tags: [
      { bookmark_id: 'b2', tag_id: 'fe', source: 'user', confidence: null, created_at: '2024' },
    ],
  };

  it('untagged excludes already-tagged bookmarks', async () => {
    const { env } = makeEnv(seed);
    expect(await resolveScope(env, 'u1', 'untagged')).toEqual(['b1']);
  });

  it('all returns every non-deleted bookmark', async () => {
    const { env } = makeEnv(seed);
    expect(await resolveScope(env, 'u1', 'all')).toEqual(['b1', 'b2']);
  });

  it('ids honours the explicit set, in the order requested', async () => {
    const { env } = makeEnv(seed);
    expect(await resolveScope(env, 'u1', 'ids', ['b2', 'b1'])).toEqual(['b2', 'b1']);
    expect(await resolveScope(env, 'u1', 'ids', [])).toEqual([]);
  });
});

describe('jobs — create / read / update', () => {
  it('creates, updates progress, and lists jobs', async () => {
    const { env } = makeEnv();
    const job = await createJob(env, 'u1', 'organize', { target: 'untagged', ids: ['b1', 'b2'] });
    expect(job.total).toBe(2);
    expect(job.status).toBe('queued');

    const fetched = await getJob(env, 'u1', job.id);
    expect(fetched?.id).toBe(job.id);

    await updateJob(env, 'u1', job.id, { status: 'running', processed: 1, engine: 'model' });
    const updated = await getJob(env, 'u1', job.id);
    expect(updated?.status).toBe('running');
    expect(updated?.processed).toBe(1);
    expect(updated?.engine).toBe('model');

    const jobs = await listJobs(env, 'u1', 5);
    expect(jobs.some((j) => j.id === job.id)).toBe(true);
  });
});

describe('incrementJobCounters — atomic, race-free progression', () => {
  it('accumulates processed/suggested/failed instead of overwriting', async () => {
    const { env } = makeEnv();
    const job = await createJob(env, 'u1', 'categorize', { target: 'ids', ids: Array.from({ length: 30 }, (_, i) => `b${i}`) });

    await incrementJobCounters(env, 'u1', job.id, { processed: 10, suggested: 10, failed: 0 });
    let fetched = await getJob(env, 'u1', job.id);
    expect(fetched?.processed).toBe(10);
    expect(fetched?.suggested).toBe(10);
    expect(fetched?.status).toBe('queued');

    await incrementJobCounters(env, 'u1', job.id, { processed: 10, suggested: 5, failed: 1 });
    fetched = await getJob(env, 'u1', job.id);
    expect(fetched?.processed).toBe(20);
    expect(fetched?.suggested).toBe(15);
    expect(fetched?.failed).toBe(1);
  });

  it('ignores non-positive deltas so a zero-length partition is a no-op', async () => {
    const { env } = makeEnv();
    const job = await createJob(env, 'u1', 'categorize', { target: 'ids', ids: Array.from({ length: 5 }, (_, i) => `b${i}`) });

    await incrementJobCounters(env, 'u1', job.id, { processed: 0, suggested: 0, failed: 0 });
    const fetched = await getJob(env, 'u1', job.id);
    expect(fetched?.processed).toBe(0);
  });

  it('sets status only when provided (finalizer flips to done, fatal to failed)', async () => {
    const { env } = makeEnv();
    const job = await createJob(env, 'u1', 'categorize', { target: 'ids', ids: Array.from({ length: 20 }, (_, i) => `b${i}`) });

    await incrementJobCounters(env, 'u1', job.id, { processed: 20, suggested: 20 });
    let fetched = await getJob(env, 'u1', job.id);
    expect(fetched?.status).toBe('queued'); // not finalizer-set yet

    await incrementJobCounters(env, 'u1', job.id, { processed: 0, status: 'done' });
    fetched = await getJob(env, 'u1', job.id);
    expect(fetched?.status).toBe('done');
    expect(fetched?.processed).toBe(20); // status change must not clobber counts

    const fatalJob = await createJob(env, 'u1', 'tagging', { target: 'ids', ids: ['x1'] });
    await incrementJobCounters(env, 'u1', fatalJob.id, { processed: 1, failed: 1, status: 'failed', error: 'bad key' });
    const fatal = await getJob(env, 'u1', fatalJob.id);
    expect(fatal?.status).toBe('failed');
    expect(fatal?.error).toBe('bad key');
    expect(fatal?.processed).toBe(1);
  });
});

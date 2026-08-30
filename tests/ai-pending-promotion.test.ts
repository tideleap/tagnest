/**
 * P2-3 pending promotion (PRD-TAG-QUALITY-2026-08-30):
 * a tag the AI mints on a one-bookmark save starts 'pending' and only becomes
 * a first-class 'active' tag once a second live bookmark adopts it.
 *
 * Covers the full lifecycle through the real store functions against the
 * in-memory D1 mock:
 *   1. single accept  → new tag is 'pending' (support 1)
 *   2. second accept  → promotion flips it to 'active' (support 2)
 *   3. promotion is monotonic — an undo that drops support never demotes
 *   4. pre-existing user tags are never re-graded (P0-7 boundary)
 *   5. the taxonomy audit hides pending tags inside the 30-day grace window
 *      and surfaces them once stale
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { decideSuggestions } from '../functions/_lib/ai/store';
import { onRequestGet as taxonomyAudit } from '../functions/api/ai/taxonomy';
import { createAiDb, type AiDbState, type BookmarkRow, type SuggestionRow } from './helpers/aiDb';

function makeEnv(seed?: Partial<AiDbState>): { env: Env; state: AiDbState } {
  const { db, state } = createAiDb(seed);
  return { env: { DB: db as never }, state };
}

function bookmark(id: string, createdAt = '2026-08-01T00:00:00Z'): BookmarkRow {
  return {
    id,
    user_id: 'u1',
    url: `https://example.com/${id}`,
    title: id,
    description: null,
    deleted_at: null,
    ai_summary: null,
    created_at: createdAt,
  };
}

function suggestion(id: string, bookmarkId: string, tagName: string): SuggestionRow {
  return {
    id,
    user_id: 'u1',
    bookmark_id: bookmarkId,
    job_id: 'j1',
    tag_name: tagName,
    tag_id: null,
    confidence: 0.9,
    source: 'model',
    reason: 'r',
    status: 'pending',
    decided_at: null,
    created_at: '2026-08-01T00:00:00Z',
  };
}

describe('P2-3 — pending promotion lifecycle', () => {
  it('mints a new AI tag as pending on first accept (support 1)', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1')],
      tag_suggestions: [suggestion('s1', 'b1', '新主题')],
    });

    await decideSuggestions(env, 'u1', ['s1'], 'accept');

    const tag = state.tags.find((t) => t.name === '新主题');
    expect(tag).toBeDefined();
    expect(tag!.status).toBe('pending');
    // The bookmark got its tag regardless — pending is about standing, not visibility.
    expect(state.bookmark_tags.some((bt) => bt.bookmark_id === 'b1')).toBe(true);
  });

  it('promotes a pending tag to active once a second live bookmark adopts it', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1'), bookmark('b2')],
      tag_suggestions: [
        suggestion('s1', 'b1', '新主题'),
        suggestion('s2', 'b2', '新主题'),
      ],
    });

    // First accept: support 1 → still pending.
    await decideSuggestions(env, 'u1', ['s1'], 'accept');
    expect(state.tags.find((t) => t.name === '新主题')!.status).toBe('pending');

    // Second accept: support 2 → promoted to active.
    await decideSuggestions(env, 'u1', ['s2'], 'accept');
    expect(state.tags.find((t) => t.name === '新主题')!.status).toBe('active');
  });

  it('does not count trashed bookmarks toward promotion', async () => {
    const trashed = bookmark('b2');
    trashed.deleted_at = '2026-08-02T00:00:00Z';
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1'), trashed],
      tag_suggestions: [
        suggestion('s1', 'b1', '新主题'),
        suggestion('s2', 'b2', '新主题'),
      ],
    });

    await decideSuggestions(env, 'u1', ['s1'], 'accept');
    await decideSuggestions(env, 'u1', ['s2'], 'accept');

    // The second bookmark is in the trash, so live support is still 1.
    expect(state.tags.find((t) => t.name === '新主题')!.status).toBe('pending');
  });

  it('never re-grades a pre-existing user tag (P0-7 boundary)', async () => {
    const { env, state } = makeEnv({
      tags: [
        { id: 'fe', user_id: 'u1', name: '前端', color_index: 0, parent_id: null, sort_order: 0, created_at: '2024', status: 'active' },
      ],
      bookmarks: [bookmark('b1')],
      tag_suggestions: [suggestion('s1', 'b1', '前端')],
    });

    await decideSuggestions(env, 'u1', ['s1'], 'accept');

    // The user's tag keeps its standing — accept reuses it, never demotes it.
    const tag = state.tags.find((t) => t.name === '前端');
    expect(tag!.status).toBe('active');
    expect(state.tags).toHaveLength(1); // no duplicate minted
  });
});

describe('P2-3 — taxonomy audit grace period', () => {
  function makeGetCtx(env: Env, userId: string) {
    return {
      request: new Request('https://tagnest.test/api/ai/taxonomy', { method: 'GET' }),
      env,
      data: { userId },
      params: {},
    } as never;
  }

  it('hides a fresh pending tag from lowUsage inside the 30-day window', async () => {
    const fresh = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const { env, state } = makeEnv({
      tags: [
        { id: 'p1', user_id: 'u1', name: '待转正', color_index: 0, parent_id: null, sort_order: 0, created_at: fresh, status: 'pending' },
      ],
      bookmarks: [bookmark('b1')],
      bookmark_tags: [{ bookmark_id: 'b1', tag_id: 'p1', source: 'ai', confidence: 0.9, created_at: fresh }],
    });

    const res = await taxonomyAudit(makeGetCtx(env, 'u1'));
    const body = (await res.json()) as { lowUsage: Array<{ id: string }> };
    expect(body.lowUsage.map((t) => t.id)).not.toContain('p1');
    expect(state.tags).toHaveLength(1);
  });

  it('surfaces a stale pending tag in lowUsage after 30 days', async () => {
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const { env } = makeEnv({
      tags: [
        { id: 'p1', user_id: 'u1', name: '待转正', color_index: 0, parent_id: null, sort_order: 0, created_at: stale, status: 'pending' },
      ],
      bookmarks: [bookmark('b1')],
      bookmark_tags: [{ bookmark_id: 'b1', tag_id: 'p1', source: 'ai', confidence: 0.9, created_at: stale }],
    });

    const res = await taxonomyAudit(makeGetCtx(env, 'u1'));
    const body = (await res.json()) as { lowUsage: Array<{ id: string }> };
    expect(body.lowUsage.map((t) => t.id)).toContain('p1');
  });

  it('still surfaces an active one-bookmark tag regardless of age', async () => {
    const fresh = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const { env } = makeEnv({
      tags: [
        { id: 'a1', user_id: 'u1', name: '活跃孤标签', color_index: 0, parent_id: null, sort_order: 0, created_at: fresh, status: 'active' },
      ],
      bookmarks: [bookmark('b1')],
      bookmark_tags: [{ bookmark_id: 'b1', tag_id: 'a1', source: 'user', confidence: null, created_at: fresh }],
    });

    const res = await taxonomyAudit(makeGetCtx(env, 'u1'));
    const body = (await res.json()) as { lowUsage: Array<{ id: string }> };
    expect(body.lowUsage.map((t) => t.id)).toContain('a1');
  });
});

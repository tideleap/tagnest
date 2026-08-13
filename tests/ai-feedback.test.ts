import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';
import { suggestForBookmarks } from '../functions/_lib/ai/engine';
import { callProvider } from '../functions/_lib/ai/providers';
import type { AiConfig, LocalConfig } from '../functions/_lib/ai/types';
import {
  buildFeedbackProfile,
  feedbackMultiplier,
  loadFeedbackProfile,
  renameByFeedback,
} from '../functions/_lib/ai/feedback';
import { decideSuggestions } from '../functions/_lib/ai/store';
import { scoreTagCandidate } from '../functions/_lib/ai/scoring';
import type { Env } from '../functions/_lib/env';
import type { TagCandidate } from '../functions/_lib/ai/types';
import { createAiDb, type AiDbState } from './helpers/aiDb';

// Only intercept the network call; keep isFatal/isRetryable real.
vi.mock('../functions/_lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../functions/_lib/ai/providers')>();
  return { ...actual, callProvider: vi.fn() };
});
const mockedCall = vi.mocked(callProvider);

const modelConfig: AiConfig = {
  provider: 'openai',
  baseUrl: null,
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  autoTag: true,
  autoSummarize: false,
  autoApplyThreshold: 1,
  maxTags: 4,
};
const local: LocalConfig = {
  autoApplyThreshold: 1,
  maxTags: 4,
};

function makeEnv(seed?: Partial<AiDbState>): { env: Env; state: AiDbState } {
  const { db, state } = createAiDb(seed);
  return { env: { DB: db as never }, state };
}

describe('feedbackMultiplier', () => {
  it('no history → neutral', () => {
    expect(feedbackMultiplier(undefined)).toEqual({ mult: 1, drop: false });
    expect(feedbackMultiplier({ accepted: 0, rejected: 0 })).toEqual({ mult: 1, drop: false });
  });
  it('strong accept rate → boost', () => {
    const e = feedbackMultiplier({ accepted: 8, rejected: 1 });
    expect(e.drop).toBe(false);
    expect(e.mult).toBeCloseTo(1.15, 5);
  });
  it('strong reject share → drop', () => {
    const e = feedbackMultiplier({ accepted: 1, rejected: 9 });
    expect(e.drop).toBe(true);
  });
  it('mixed history → mild penalty, never below the mixed floor', () => {
    const e = feedbackMultiplier({ accepted: 3, rejected: 2 });
    expect(e.drop).toBe(false);
    expect(e.mult).toBeGreaterThanOrEqual(0.6);
    expect(e.mult).toBeLessThan(1);
  });
});

describe('buildFeedbackProfile', () => {
  it('aggregates tag + tag-domain tallies and the modified mapping', () => {
    const p = buildFeedbackProfile([
      { tagName: 'React', action: 'accepted', domain: 'github.com' },
      { tagName: 'React', action: 'accepted', domain: 'github.com' },
      { tagName: 'React', action: 'accepted', domain: 'example.com' },
      { tagName: 'React', action: 'rejected', domain: 'github.com' },
      { tagName: 'react', action: 'modified', context: 'React.js' },
    ]);
    expect(p.byTag.get('react')).toEqual({ accepted: 3, rejected: 2 });
    expect(p.byTagDomain.get('react|github.com')).toEqual({ accepted: 2, rejected: 1 });
    expect(p.modifiedTo.get('react')).toBe('React.js');
    expect(p.total).toBe(5);
  });
});

describe('renameByFeedback', () => {
  it('returns the user-preferred spelling, else the original', () => {
    const p = buildFeedbackProfile([{ tagName: 'react', action: 'modified', context: 'React.js' }]);
    expect(renameByFeedback('React', p)).toBe('React.js');
    expect(renameByFeedback('Vue', p)).toBe('Vue');
  });
});

describe('scoreTagCandidate with feedback', () => {
  // Title deliberately omits "React" so the lexical-evidence bonus does not
  // muddy the confidence math being asserted here.
  const input = { url: 'https://github.com/foo/bar', title: 'A repo' };
  const base: TagCandidate = { name: 'React', tagId: null, confidence: 0.6, source: 'fallback', reason: '' };

  it('boosts a strongly-accepted tag on the same domain', () => {
    const profile = buildFeedbackProfile([
      { tagName: 'React', action: 'accepted', domain: 'github.com' },
      { tagName: 'React', action: 'accepted', domain: 'github.com' },
      { tagName: 'React', action: 'accepted', domain: 'github.com' },
    ]);
    const out = scoreTagCandidate(base, input, 1, null, profile);
    expect(out).not.toBeNull();
    expect(out!.feedbackBoosted).toBe(true);
    expect(out!.confidence).toBeCloseTo(0.6 * 1.15, 5);
  });

  it('drops a strongly-rejected tag', () => {
    const profile = buildFeedbackProfile([
      { tagName: 'React', action: 'rejected', domain: 'github.com' },
      { tagName: 'React', action: 'rejected', domain: 'github.com' },
      { tagName: 'React', action: 'rejected', domain: 'github.com' },
    ]);
    expect(scoreTagCandidate(base, input, 1, null, profile)).toBeNull();
  });

  it('no feedback → untouched and flag false', () => {
    const out = scoreTagCandidate(base, input, 1, null, null);
    expect(out).not.toBeNull();
    expect(out!.feedbackBoosted).toBe(false);
    expect(out!.confidence).toBe(0.6);
  });
});

describe('engine applies the feedback rename', () => {
  beforeEach(() => mockedCall.mockReset());
  it('renames a candidate to the user-preferred spelling', async () => {
    const profile = buildFeedbackProfile([{ tagName: 'react', action: 'modified', context: 'React.js' }]);
    mockedCall.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ results: [{ i: 1, tags: [{ name: 'react', confidence: 0.9, reason: 'x' }] }] }),
    });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://example.com/x', title: 't' }],
      { vocab: buildVocabulary([]), config: modelConfig, local, feedback: profile },
    );
    expect(out.results[0].tags.map((t) => t.name)).toContain('React.js');
    expect(out.results[0].tags.map((t) => t.name)).not.toContain('react');
  });
});

describe('decideSuggestions records feedback', () => {
  const seed = (tagName: string) => ({
    bookmarks: [
      {
        id: 'b1',
        user_id: 'u1',
        url: 'https://github.com/foo',
        title: 'Repo',
        description: null,
        deleted_at: null,
        ai_summary: null,
        created_at: '2024',
      },
    ],
    tag_suggestions: [
      {
        id: 's1',
        user_id: 'u1',
        bookmark_id: 'b1',
        job_id: 'j1',
        tag_name: tagName,
        tag_id: null,
        confidence: 0.9,
        source: 'model',
        reason: null,
        status: 'pending' as const,
        decided_at: null,
        created_at: '2024',
      },
    ],
  });

  it('accept writes an accepted feedback row and applies the tag', async () => {
    const { env, state } = makeEnv(seed('前端'));
    const out = await decideSuggestions(env, 'u1', ['s1'], 'accept');
    expect(out.accepted).toBe(1);
    expect(state.bookmark_tags).toHaveLength(1);
    expect(state.bookmark_tags[0].source).toBe('ai');
    expect(state.ai_feedback).toHaveLength(1);
    expect(state.ai_feedback[0]).toMatchObject({
      bookmark_id: 'b1',
      tag_name: '前端',
      action: 'accepted',
      domain: 'github.com',
    });
  });

  it('reject writes a rejected feedback row and applies nothing', async () => {
    const { env, state } = makeEnv(seed('前端'));
    const out = await decideSuggestions(env, 'u1', ['s1'], 'reject');
    expect(out.rejected).toBe(1);
    expect(state.bookmark_tags).toHaveLength(0);
    expect(state.ai_feedback).toHaveLength(1);
    expect(state.ai_feedback[0].action).toBe('rejected');
  });

  it('rename records a modified event plus an accepted event for the new name', async () => {
    const { env, state } = makeEnv(seed('react'));
    const out = await decideSuggestions(env, 'u1', ['s1'], 'accept', { renameTo: 'React.js' });
    expect(out.accepted).toBe(1);
    const modified = state.ai_feedback.find((f) => f.action === 'modified');
    expect(modified).toBeDefined();
    expect(modified!.tag_name).toBe('react');
    expect(modified!.context).toBe('React.js');
    const acceptedNew = state.ai_feedback.find(
      (f) => f.action === 'accepted' && f.tag_name === 'React.js',
    );
    expect(acceptedNew).toBeDefined();
  });
});

describe('loadFeedbackProfile', () => {
  it('reads aggregated history from the store', async () => {
    const { env } = makeEnv({
      ai_feedback: [
        {
          id: 'f1',
          user_id: 'u1',
          bookmark_id: 'b1',
          tag_name: '前端',
          action: 'accepted',
          final_tag_id: null,
          source: 'model',
          confidence: 0.9,
          domain: 'github.com',
          context: 'x',
          created_at: '2024',
        },
        {
          id: 'f2',
          user_id: 'u1',
          bookmark_id: 'b1',
          tag_name: '前端',
          action: 'accepted',
          final_tag_id: null,
          source: 'model',
          confidence: 0.9,
          domain: 'github.com',
          context: 'x',
          created_at: '2024',
        },
      ],
    });
    const profile = await loadFeedbackProfile(env, 'u1');
    expect(profile.byTag.get('前端')).toEqual({ accepted: 2, rejected: 0 });
  });
});

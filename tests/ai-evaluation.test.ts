import { describe, it, expect } from 'vitest';
import {
  summarizeFeedback,
  computeHitRate,
  buildFeedbackTrend,
  loadFeedbackMetrics,
  loadFeedbackTrend,
  type FeedbackAction,
} from '../functions/_lib/ai/feedback';
import { onRequestGet as overviewHandler } from '../functions/api/ai/overview';
import { PROMPT_VERSION } from '../functions/_lib/ai/prompt';
import { createAiDb } from './helpers/aiDb';

/* ------------------------------------------------------------------ *
 * Pure aggregation logic — the substantive Phase 5 math.
 * ------------------------------------------------------------------ */

describe('summarizeFeedback', () => {
  it('treats a rename as "kept" and never divides by zero', () => {
    const actions: FeedbackAction[] = ['accepted', 'accepted', 'rejected', 'modified'];
    const r = summarizeFeedback(actions);
    expect(r.total).toBe(4);
    expect(r.accepted).toBe(2);
    expect(r.rejected).toBe(1);
    expect(r.modified).toBe(1);
    // kept = accepted(2) + modified(1) = 3 over resolved(4) => 0.75
    expect(r.acceptanceRate).toBeCloseTo(0.75);
    expect(summarizeFeedback([]).acceptanceRate).toBe(0);
  });
});

describe('computeHitRate', () => {
  it('is accepted / total and 0 when nothing was proposed', () => {
    expect(computeHitRate(0, 0)).toBe(0);
    expect(computeHitRate(3, 10)).toBeCloseTo(0.3);
    expect(computeHitRate(0, 5)).toBe(0);
  });
});

describe('buildFeedbackTrend', () => {
  const endDate = new Date('2026-08-09T00:00:00.000Z');

  it('emits a contiguous window and zero-fills gaps', () => {
    const rows = [
      { day: '2026-08-09', action: 'accepted' as FeedbackAction, count: 5 },
      { day: '2026-08-09', action: 'rejected' as FeedbackAction, count: 1 },
      { day: '2026-08-08', action: 'rejected' as FeedbackAction, count: 2 },
    ];
    const series = buildFeedbackTrend(rows, 30, endDate);
    expect(series.length).toBe(30);

    const last = series[29];
    expect(last.date).toBe('2026-08-09');
    expect(last.accepted).toBe(5);
    expect(last.rejected).toBe(1);

    const prev = series[28];
    expect(prev.date).toBe('2026-08-08');
    expect(prev.accepted).toBe(0);
    expect(prev.rejected).toBe(2);

    const dates = series.map((s) => s.date);
    expect(new Set(dates).size).toBe(30);
    expect([...dates].sort()).toEqual(dates); // ascending
  });

  it('ignores unparseable dates instead of crashing', () => {
    const series = buildFeedbackTrend(
      [{ day: 'nonsense', action: 'accepted', count: 3 }],
      7,
      endDate,
    );
    expect(series.every((p) => p.accepted === 0 && p.rejected === 0)).toBe(true);
  });

  it('respects a custom window length', () => {
    expect(buildFeedbackTrend([], 14, endDate).length).toBe(14);
  });
});

/* ------------------------------------------------------------------ *
 * DB accessors — exercise the new aggregate queries through the mock.
 * ------------------------------------------------------------------ */

function seedDecision(
  state: ReturnType<typeof createAiDb>['state'],
  user: string,
  action: FeedbackAction,
  status: 'accepted' | 'rejected' | 'pending',
  now: string,
) {
  state.ai_feedback.push({
    id: `f_${user}_${action}_${state.ai_feedback.length}`,
    user_id: user,
    bookmark_id: `b_${state.ai_feedback.length}`,
    tag_name: 'react',
    action,
    final_tag_id: null,
    source: 'model',
    confidence: 0.9,
    domain: 'github.com',
    context: 'ctx',
    created_at: now,
  });
  state.tag_suggestions.push({
    id: `s_${user}_${status}_${state.tag_suggestions.length}`,
    user_id: user,
    bookmark_id: `b_${state.tag_suggestions.length}`,
    job_id: null,
    tag_name: 'react',
    tag_id: null,
    confidence: 0.9,
    source: 'model',
    reason: null,
    status,
    decided_at: status === 'pending' ? null : now,
    created_at: now,
  });
}

describe('loadFeedbackMetrics', () => {
  it('aggregates feedback actions and suggestion statuses, scoped to the user', async () => {
    const { db, state } = createAiDb();
    const now = new Date().toISOString();
    seedDecision(state, 'u1', 'accepted', 'accepted', now);
    seedDecision(state, 'u1', 'accepted', 'accepted', now);
    seedDecision(state, 'u1', 'rejected', 'rejected', now);
    seedDecision(state, 'u1', 'modified', 'accepted', now);
    // A proposal still awaiting the user's decision has no feedback event yet.
    state.tag_suggestions.push({
      id: 's_pending',
      user_id: 'u1',
      bookmark_id: 'b_pending',
      job_id: null,
      tag_name: 'react',
      tag_id: null,
      confidence: 0.9,
      source: 'model',
      reason: null,
      status: 'pending',
      decided_at: null,
      created_at: now,
    });
    seedDecision(state, 'u2', 'accepted', 'accepted', now); // other user ignored

    const m = await loadFeedbackMetrics({ DB: db } as never, 'u1');
    expect(m.accepted).toBe(2);
    expect(m.rejected).toBe(1);
    expect(m.modified).toBe(1);
    expect(m.total).toBe(4);
    expect(m.acceptanceRate).toBeCloseTo(3 / 4);

    // proposed = 5 suggestions (4 decisions + 1 still pending); accepted = 3.
    expect(m.proposalTotal).toBe(5);
    expect(m.proposalAccepted).toBe(3);
    expect(m.hitRate).toBeCloseTo(3 / 5);
  });
});

describe('loadFeedbackTrend', () => {
  it('returns a 30-day series containing the seeded day', async () => {
    const { db, state } = createAiDb();
    const now = new Date().toISOString();
    seedDecision(state, 'u1', 'accepted', 'accepted', now);
    seedDecision(state, 'u1', 'rejected', 'rejected', now);

    const trend = await loadFeedbackTrend({ DB: db } as never, 'u1', 30);
    expect(trend.length).toBe(30);
    const today = now.slice(0, 10);
    const point = trend.find((p) => p.date === today);
    expect(point?.accepted).toBe(1);
    expect(point?.rejected).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Endpoint — the overview now carries the evaluation payload.
 * ------------------------------------------------------------------ */

describe('GET /ai/overview', () => {
  it('surfaces feedback metrics, trend and the active prompt version', async () => {
    const { db, state } = createAiDb();
    const now = new Date().toISOString();
    state.ai_settings.push({
      user_id: 'u1',
      provider: 'none',
      base_url: null,
      model: '',
      api_key_encrypted: null,
      auto_tag: 0,
      auto_summarize: 0,
      auto_apply_threshold: 1,
      heuristics_enabled: 1,
      max_tags: 4,
    });
    seedDecision(state, 'u1', 'accepted', 'accepted', now);

    const ctx = {
      request: new Request('https://tagnest.test/api/ai/overview'),
      env: { DB: db },
      data: { userId: 'u1' },
    } as never;

    const res = await overviewHandler(ctx);
    const body = (await res.json()) as {
      promptVersion: string;
      feedback: {
        total: number;
        acceptanceRate: number;
        hitRate: number;
      };
      feedbackTrend: Array<{ date: string }>;
    };

    expect(body.promptVersion).toBe(PROMPT_VERSION);
    expect(body.feedback.total).toBe(1);
    expect(body.feedback.acceptanceRate).toBeCloseTo(1);
    expect(body.feedback.hitRate).toBeCloseTo(1);
    expect(Array.isArray(body.feedbackTrend)).toBe(true);
    expect(body.feedbackTrend.length).toBe(30);
  });
});

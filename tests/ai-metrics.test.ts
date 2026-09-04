import { describe, expect, it } from 'vitest';
import { computeContribution, computeUsageRate, loadAiUsage } from '../functions/_lib/ai/metrics';
import { makeEnv, type MockDb } from './_support/dbMock';

describe('computeUsageRate', () => {
  it('is the touched share of the bookmark pool', () => {
    expect(computeUsageRate(63, 150)).toBeCloseTo(0.42, 5);
  });

  it('is 0 when there are no bookmarks', () => {
    expect(computeUsageRate(5, 0)).toBe(0);
  });

  it('never exceeds 1', () => {
    expect(computeUsageRate(200, 150)).toBe(1);
  });
});

describe('computeContribution (value-weighted model)', () => {
  it('matches the worked example from the design doc', () => {
    // 70 direct (1.0) + 20 modified (0.6) + 10 fallback (0.5) + 100 user-only.
    const m = computeContribution({
      direct: 70,
      modified: 20,
      fallback: 10,
      rejected: 30,
      userOnly: 100,
    });

    expect(m.raw.aiAccepted).toBe(100);
    expect(m.raw.modified).toBe(20);
    expect(m.raw.rejected).toBe(30);
    expect(m.raw.fallbackAccepted).toBe(10);
    expect(m.raw.userCreated).toBe(100);

    // weighted = 70 + 12 + 5 = 87; denom = 100 + 100 = 187 → 46.52%.
    expect(m.weightedRate).toBeCloseTo(87 / 187, 5);
    expect(Math.round(m.weightedRate * 100)).toBe(47);

    // hit rate = accepted / (accepted + rejected) = 100 / 130.
    expect(m.hitRate).toBeCloseTo(100 / 130, 5);
    expect(m.acceptanceRate).toBeCloseTo(100 / 130, 5);
  });

  it('excludes rejected proposals from the denominator', () => {
    const m = computeContribution({
      direct: 10,
      modified: 0,
      fallback: 0,
      rejected: 90,
      userOnly: 0,
    });
    // 10 accepted, 90 rejected → rate stays at 1.0 (rejection does not dilute).
    expect(m.weightedRate).toBe(1);
    expect(m.raw.aiAccepted).toBe(10);
  });

  it('is 0 with no landed links', () => {
    const m = computeContribution({
      direct: 0,
      modified: 0,
      fallback: 0,
      rejected: 0,
      userOnly: 0,
    });
    expect(m.weightedRate).toBe(0);
    expect(m.hitRate).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * B-11: 'all'/'untagged' runs must count toward touched bookmarks.
 *
 * Before the fix, `touchedTarget` was only seeded from `scope.ids`, so a
 * whole-library run (target='all', empty ids) contributed zero touched
 * bookmarks and the adoption rate read as 0 even though the run wrote
 * suggestions for the entire library. The fix attributes those bookmarks
 * through the suggestions the run actually wrote.
 * ------------------------------------------------------------------ */

const NOW = Date.now();
const RECENT = new Date(NOW - 2 * 86_400_000).toISOString(); // 2 days ago, in window

function seedJob(
  db: MockDb,
  id: string,
  userId: string,
  scope: { target: string; ids?: string[] },
  total: number,
): void {
  db.ai_jobs.push({
    id,
    user_id: userId,
    kind: 'tagging',
    status: 'done',
    scope: JSON.stringify(scope),
    total,
    processed: total,
    suggested: 0,
    failed: 0,
    engine: 'model',
    error: null,
    created_at: RECENT,
    updated_at: RECENT,
    prompt_version: null,
  });
}

function seedSuggestion(
  db: MockDb,
  userId: string,
  jobId: string | null,
  bookmarkId: string,
): void {
  db.tag_suggestions.push({
    id: `s-${bookmarkId}-${jobId ?? 'oneoff'}`,
    user_id: userId,
    job_id: jobId,
    bookmark_id: bookmarkId,
    tag_name: 'tag',
    confidence: 0.9,
    status: 'accepted',
    created_at: RECENT,
  });
}

describe('loadAiUsage — B-11 touched-bookmark attribution', () => {
  it('counts bookmarks touched by an all-scope run via its written suggestions', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const userId = 'u1';

    // A whole-library run: target='all', no id list. It wrote suggestions for
    // three bookmarks. Pre-fix these contributed nothing to touchedBookmarks.
    seedJob(db, 'job-all', userId, { target: 'all' }, 3);
    seedSuggestion(db, userId, 'job-all', 'b1');
    seedSuggestion(db, userId, 'job-all', 'b2');
    seedSuggestion(db, userId, 'job-all', 'b3');

    const usage = await loadAiUsage(env, userId, 10);
    expect(usage.touchedBookmarks).toBe(3);
    expect(usage.adoptionRate).toBeCloseTo(0.3, 5);
    // All three attributed to the 'all' scope.
    const all = usage.byScope.find((s) => s.target === 'all');
    expect(all?.count).toBe(3);
  });

  it('still counts ids-scope bookmarks and merges suggestion attribution', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const userId = 'u1';

    // An ids run that explicitly lists two bookmarks.
    seedJob(db, 'job-ids', userId, { target: 'ids', ids: ['b10', 'b11'] }, 2);
    // An untagged run that wrote a suggestion for a third bookmark.
    seedJob(db, 'job-untagged', userId, { target: 'untagged' }, 1);
    seedSuggestion(db, userId, 'job-untagged', 'b12');

    const usage = await loadAiUsage(env, userId, 10);
    // b10, b11 (from ids) + b12 (from the untagged run's suggestion).
    expect(usage.touchedBookmarks).toBe(3);
    expect(usage.byScope.find((s) => s.target === 'ids')?.count).toBe(2);
    expect(usage.byScope.find((s) => s.target === 'untagged')?.count).toBe(1);
  });

  it('attributes one-off (job_id NULL) suggestions to the ids scope', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const userId = 'u1';

    // No job at all — a single-bookmark suggestion created outside a batch run.
    seedSuggestion(db, userId, null, 'b20');

    const usage = await loadAiUsage(env, userId, 10);
    expect(usage.touchedBookmarks).toBe(1);
    expect(usage.byScope.find((s) => s.target === 'ids')?.count).toBe(1);
  });

  it('does not double-count a bookmark reached by both an ids run and a suggestion', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const userId = 'u1';

    seedJob(db, 'job-ids', userId, { target: 'ids', ids: ['b30'] }, 1);
    // The same bookmark also got a suggestion from that run.
    seedSuggestion(db, userId, 'job-ids', 'b30');

    const usage = await loadAiUsage(env, userId, 10);
    expect(usage.touchedBookmarks).toBe(1);
  });

  it('ignores suggestions written outside the 30-day window', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    const userId = 'u1';

    seedJob(db, 'job-all', userId, { target: 'all' }, 1);
    // An old suggestion outside the window must not count.
    db.tag_suggestions.push({
      id: 's-old',
      user_id: userId,
      job_id: 'job-all',
      bookmark_id: 'b-old',
      tag_name: 'tag',
      confidence: 0.9,
      status: 'accepted',
      created_at: new Date(NOW - 60 * 86_400_000).toISOString(),
    });

    const usage = await loadAiUsage(env, userId, 10);
    expect(usage.touchedBookmarks).toBe(0);
  });
});

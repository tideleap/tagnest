import { describe, expect, it } from 'vitest';
import { computeContribution, computeUsageRate } from '../functions/_lib/ai/metrics';

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
    expect(m.raw.heuristicAccepted).toBe(10);
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

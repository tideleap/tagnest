import { describe, expect, it } from 'vitest';
import {
  LEXICAL_BONUS,
  lexicalEvidence,
  sameHostBoost,
  scoreTagCandidate,
  tagFrequencyFactor,
  MIN_MODEL_CONFIDENCE,
} from '../functions/_lib/ai/scoring';
import type { TagCandidate } from '../functions/_lib/ai/types';

const input = { url: 'https://docs.python.org/3/guide', title: 'Python 教程与参考', description: '深入 Python 语言' };

describe('tagFrequencyFactor', () => {
  it('is neutral for unknown/zero-count tags', () => {
    expect(tagFrequencyFactor(0)).toBeCloseTo(1);
  });
  it('grows quickly for low counts and saturates', () => {
    expect(tagFrequencyFactor(1)).toBeGreaterThan(1);
    expect(tagFrequencyFactor(3)).toBeGreaterThan(tagFrequencyFactor(1));
    expect(tagFrequencyFactor(50)).toBeCloseTo(fifty(), 2);
    expect(tagFrequencyFactor(1e6)).toBeLessThan(1.3); // saturation cap
    expect(tagFrequencyFactor(-5)).toBeCloseTo(1); // clamps negatives
  });
});
function fifty() {
  return tagFrequencyFactor(50);
}

describe('lexicalEvidence', () => {
  it('returns 1 for direct containment of the tag in title', () => {
    expect(lexicalEvidence(input, 'Python')).toBe(1);
  });
  it('returns null when there is no overlap', () => {
    expect(lexicalEvidence(input, '前端')).toBeNull();
  });
  it('handles empty text', () => {
    expect(lexicalEvidence({ url: 'https://x', title: '', description: '' }, '任何')).toBeNull();
  });
});

describe('scoreTagCandidate — confidence floor + signal boosts', () => {
  const base = (source: TagCandidate['source'], confidence: number): TagCandidate => ({
    name: 'Python',
    tagId: null,
    confidence,
    source,
    reason: '',
  });

  it('keeps a strong heuristic candidate, boosted by lexical evidence', () => {
    const scored = scoreTagCandidate(base('fallback', 0.5), input, 1, null);
    expect(scored).not.toBeNull();
    // 0.5 + LEXICAL_BONUS (page mentions Python) => 0.62
    expect(scored!.confidence).toBeCloseTo(0.5 + LEXICAL_BONUS);
  });

  it('drops a weak heuristic candidate that lands below the floor', () => {
    // No lexical evidence and a low base confidence -> 0.3 < 0.4 floor.
    const weak = scoreTagCandidate(base('fallback', 0.3), { url: 'u', title: 'x', description: '' }, 1, null);
    expect(weak).toBeNull();
    // Even with lexical help, a very weak candidate can be rescued above the
    // floor — that is the intended behaviour, not a bug.
    const rescued = scoreTagCandidate(base('fallback', 0.2), input, 1, null);
    // 0.2 + 0.12 (Python appears in text) = 0.32 < 0.4 still dropped.
    expect(rescued).toBeNull();
  });

  it('applies a frequency boost when the tag already exists for the user', () => {
    const freq = tagFrequencyFactor(25); // popular tag
    const scored = scoreTagCandidate(base('model', 0.6), { url: 'u', title: '', description: '' }, 1, {
      id: 't1',
      name: 'Python',
      aliases: [],
      count: 25,
    });
    expect(scored!.confidence).toBeGreaterThan(0.6);
    expect(scored!.confidence).toBeCloseTo(0.6 * freq, 5);
  });

  it('applies the same-host neighbourhood boost', () => {
    const peers = [
      { id: 'b0', url: 'https://docs.python.org/guide', title: 'Python 教程', description: null },
      { id: 'b1', url: 'https://docs.python.org/ref', title: 'Python 参考', description: null },
    ];
    const boost = sameHostBoost(peers, 0, 'Python');
    expect(boost).toBeGreaterThan(1); // peer overlaps with "Python"
    const boosted = scoreTagCandidate(base('model', 0.5), peers[0], boost, null);
    expect(boosted!.confidence).toBeGreaterThan(0.5);
  });

  it('returns null below the model confidence floor', () => {
    const weak = scoreTagCandidate(base('model', MIN_MODEL_CONFIDENCE - 0.05), { url: 'u', title: '', description: '' }, 1, null);
    expect(weak).toBeNull();
  });

  it('caps confidence at 1', () => {
    const scored = scoreTagCandidate(base('fallback', 0.9), input, 1.15, { id: 't', name: 'Python', aliases: [], count: 99 });
    expect(scored!.confidence).toBeLessThanOrEqual(1);
  });
});

import { describe, expect, it } from 'vitest';
import type { SuggestionResult } from '../functions/_lib/ai/engine';
import { aggregateTopics } from '../functions/_lib/ai/engine';

/** Builds a minimal SuggestionResult with just the fields aggregateTopics reads. */
function result(topic: string | null): SuggestionResult {
  return {
    bookmarkId: `bm-${Math.random()}`,
    tags: [],
    summary: null,
    topic,
    needsReview: false,
  };
}

describe('aggregateTopics', () => {
  it('counts bookmarks by topic and sorts by count desc', () => {
    const out = aggregateTopics([
      result('前端'),
      result('前端'),
      result('AI'),
      result('AI'),
      result('AI'),
      result('设计'),
    ]);

    expect(out).toEqual([
      { topic: 'AI', count: 3 },
      { topic: '前端', count: 2 },
      { topic: '设计', count: 1 },
    ]);
  });

  it('drops null topics', () => {
    const out = aggregateTopics([result(null), result('AI'), result(null)]);
    expect(out).toEqual([{ topic: 'AI', count: 1 }]);
  });

  it('returns an empty array for no input', () => {
    expect(aggregateTopics([])).toEqual([]);
  });

  it('ties broken by topic name (ascending)', () => {
    const out = aggregateTopics([result('B'), result('A')]);
    expect(out).toEqual([
      { topic: 'A', count: 1 },
      { topic: 'B', count: 1 },
    ]);
  });
});

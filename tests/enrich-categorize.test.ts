/**
 * CS-P5-1: enrichBookmark must also classify a bookmark inline (not just tag),
 * gated by the same `autoTag` master switch and reusing the categorize KV cache.
 *
 * The test mocks the heavy IO (config/feedback/logger) and the two functions
 * under the categorize track so we can assert the orchestration in enrichBookmark
 * without a database or a network.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  categorizeBookmarks: vi.fn(),
  saveCategorySuggestions: vi.fn(async () => 0),
}));

vi.mock('../functions/_lib/ai/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../functions/_lib/ai/engine')>();
  return {
    ...actual,
    suggestForBookmarks: vi.fn(async () => ({
      results: [
        {
          bookmarkId: 'bm1',
          tags: [{ name: 'react', tagId: 'r', confidence: 0.9, source: 'model' as const, reason: 'x' }],
          summary: null,
          topic: null,
          needsReview: false,
        },
      ],
      engine: 'none',
      modelError: null,
      fatal: false,
      uncovered: 0,
    })),
    // categorizeBookmarks is imported from './engine' in index.ts; route it to
    // the shared mock so we can assert the categorize track.
    categorizeBookmarks: (...args: unknown[]) => mocks.categorizeBookmarks(...args),
  };
});

vi.mock('../functions/_lib/ai/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../functions/_lib/ai/store')>();
  return {
    ...actual,
    categorizeBookmarks: (...args: unknown[]) => mocks.categorizeBookmarks(...args),
    saveCategorySuggestions: (...args: unknown[]) => mocks.saveCategorySuggestions(...args),
    // The tagging track exercises saveSuggestions; we stub it so enrichBookmark
    // proceeds to the categorize track without a database.
    saveSuggestions: vi.fn(async () => 0),
  };
});

const cfgStub = {
  provider: 'openai',
  baseUrl: null,
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  autoTag: true,
  autoSummarize: false,
  autoApplyThreshold: 1,
  maxTags: 4,
  fetchContent: false,
  twoPass: false,
};

vi.mock('../functions/_lib/ai/config', () => ({
  loadConfigRow: vi.fn(async () => ({})),
  toLocalConfig: vi.fn(() => ({})),
  loadAiConfig: vi.fn(async () => cfgStub),
  loadVocabulary: vi.fn(async () => ({ roots: [], nodes: new Map() })),
  isModelReady: vi.fn(() => true),
}));

vi.mock('../functions/_lib/ai/feedback', () => ({
  loadFeedbackProfile: vi.fn(async () => null),
}));

vi.mock('../functions/_lib/ai/url-cache', () => ({
  makeKvTagCache: vi.fn(() => ({})),
  makeKvCategoryCache: vi.fn(() => ({})),
}));

vi.mock('../functions/_lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { enrichBookmark } from '../functions/_lib/ai';

const baseInput = { url: 'https://react.dev/', title: 'React' };

function makeEnv() {
  return { DB: {} as never, AI_CACHE: {} as never, LOG_LEVEL: 'info' };
}

beforeEach(() => {
  mocks.categorizeBookmarks.mockReset();
  mocks.saveCategorySuggestions.mockReset();
  mocks.categorizeBookmarks.mockResolvedValue({
    results: [],
    engine: 'none',
    modelError: null,
    fatal: false,
    uncovered: 0,
    uncategorized: 0,
  });
});

describe('enrichBookmark — inline categorization (C6-1)', () => {
  it('classifies and queues a suggestion when autoTag is on and the model returns a category', async () => {
    mocks.categorizeBookmarks.mockResolvedValueOnce({
      results: [
        {
          bookmarkId: 'bm1',
          category: {
            path: ['开发技术', '前端开发'],
            tagId: 'fe',
            confidence: 0.92,
            source: 'model',
            reason: 'React 官方文档',
            isNew: false,
            needsReview: false,
          },
        },
      ],
      engine: 'model',
      modelError: null,
      fatal: false,
      uncovered: 0,
      uncategorized: 0,
    });

    await enrichBookmark(makeEnv() as never, 'user1', 'bm1', baseInput);

    expect(mocks.categorizeBookmarks).toHaveBeenCalledTimes(1);
    // categorise receives the bookmark with its id spliced in.
    const [inputs, options] = mocks.categorizeBookmarks.mock.calls[0];
    expect(inputs[0]).toMatchObject({ id: 'bm1', url: 'https://react.dev/' });
    expect(options.config.autoTag).toBe(true);
    expect(mocks.saveCategorySuggestions).toHaveBeenCalledTimes(1);
    // enrich writes with jobId = null (the inline path).
    expect(mocks.saveCategorySuggestions.mock.calls[0][2]).toBeNull();
    expect(mocks.saveCategorySuggestions.mock.calls[0][3][0].bookmarkId).toBe('bm1');
  });

  it('does not categorise when autoTag is off', async () => {
    cfgStub.autoTag = false;
    try {
      await enrichBookmark(makeEnv() as never, 'user1', 'bm1', baseInput);
      expect(mocks.categorizeBookmarks).not.toHaveBeenCalled();
      expect(mocks.saveCategorySuggestions).not.toHaveBeenCalled();
    } finally {
      cfgStub.autoTag = true;
    }
  });

  it('does not save a category when the engine returns no category', async () => {
    mocks.categorizeBookmarks.mockResolvedValueOnce({
      results: [{ bookmarkId: 'bm1', category: null }],
      engine: 'fallback',
      modelError: null,
      fatal: false,
      uncovered: 1,
      uncategorized: 1,
    });

    await enrichBookmark(makeEnv() as never, 'user1', 'bm1', baseInput);

    expect(mocks.categorizeBookmarks).toHaveBeenCalledTimes(1);
    expect(mocks.saveCategorySuggestions).not.toHaveBeenCalled();
  });
});

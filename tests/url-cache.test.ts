import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { suggestForBookmarks } from '../functions/_lib/ai/engine';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';
import { cacheKeyFor, normalizeUrlForCache, type TagCache, type TagCacheEntry } from '../functions/_lib/ai/url-cache';
import { callProvider } from '../functions/_lib/ai/providers';
import type { AiConfig, LocalConfig, Vocabulary } from '../functions/_lib/ai/types';

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

const local: LocalConfig = { autoApplyThreshold: 1, maxTags: 4 };
const emptyVocab: Vocabulary = buildVocabulary([]);

/** In-memory TagCache standing in for KV. */
function memoryCache(): TagCache & { store: Map<string, TagCacheEntry> } {
  const store = new Map<string, TagCacheEntry>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, entry) {
      store.set(key, entry);
    },
  };
}

beforeEach(() => mockedCall.mockReset());
afterEach(() => mockedCall.mockReset());

describe('normalizeUrlForCache / cacheKeyFor (P1-2)', () => {
  it('drops the fragment but keeps the query', () => {
    expect(normalizeUrlForCache('https://x.com/a#sec')).toBe('https://x.com/a');
    expect(normalizeUrlForCache('https://x.com/a?q=1')).toBe('https://x.com/a?q=1');
  });

  it('is stable for the same URL+model and differs across models', async () => {
    const k1 = await cacheKeyFor('https://x.com/a', 'gpt-4o-mini');
    const k2 = await cacheKeyFor('https://x.com/a', 'gpt-4o-mini');
    const k3 = await cacheKeyFor('https://x.com/a', 'claude-3');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toContain('ai:tag:');
  });

  it('differs across URLs', async () => {
    const k1 = await cacheKeyFor('https://x.com/a', 'm');
    const k2 = await cacheKeyFor('https://x.com/b', 'm');
    expect(k1).not.toBe(k2);
  });
});

describe('suggestForBookmarks — P1-2 URL result cache', () => {
  it('serves a cache hit without calling the model', async () => {
    const cache = memoryCache();
    const key = await cacheKeyFor('https://react.dev', modelConfig.model);
    cache.store.set(key, {
      tags: [{ name: '前端', confidence: 0.9, reason: '缓存', isNew: false }],
      summary: null,
      topic: '前端框架',
      needsReview: false,
    });

    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://react.dev', title: 'React' }],
      { vocab: emptyVocab, config: modelConfig, local, tagCache: cache },
    );

    expect(mockedCall).not.toHaveBeenCalled();
    expect(out.engine).toBe('model');
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
    expect(out.results[0].topic).toBe('前端框架');
  });

  it('calls the model on a miss and writes the result back', async () => {
    const cache = memoryCache();
    mockedCall.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'r' }], topic: '前端框架' }],
      }),
    });

    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://react.dev', title: 'React' }],
      { vocab: emptyVocab, config: modelConfig, local, tagCache: cache },
    );

    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
    // Write-back happened under the URL's key.
    const key = await cacheKeyFor('https://react.dev', modelConfig.model);
    const stored = cache.store.get(key);
    expect(stored).toBeDefined();
    expect(stored?.tags[0].name).toBe('前端');
  });

  it('does not cache empty results (a quiet model must not poison the next run)', async () => {
    const cache = memoryCache();
    mockedCall.mockResolvedValue({ ok: true, text: JSON.stringify({ results: [] }) });

    await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo', title: 'Repo' }],
      { vocab: emptyVocab, config: modelConfig, local, tagCache: cache },
    );

    const key = await cacheKeyFor('https://github.com/foo', modelConfig.model);
    expect(cache.store.has(key)).toBe(false);
  });

  it('mixes hits and misses in one batch, calling the model only for misses', async () => {
    const cache = memoryCache();
    const hitKey = await cacheKeyFor('https://react.dev', modelConfig.model);
    cache.store.set(hitKey, {
      tags: [{ name: '前端', confidence: 0.9, reason: '缓存', isNew: false }],
      summary: null,
      topic: '前端框架',
      needsReview: false,
    });
    mockedCall.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        results: [{ i: 1, tags: [{ name: '后端', confidence: 0.9, reason: 'r' }] }],
      }),
    });

    const out = await suggestForBookmarks(
      [
        { id: 'b1', url: 'https://react.dev', title: 'React' },
        { id: 'b2', url: 'https://nodejs.org', title: 'Node' },
      ],
      { vocab: emptyVocab, config: modelConfig, local, tagCache: cache },
    );

    // Only the miss (b2) went to the model.
    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
    expect(out.results[1].tags.map((t) => t.name)).toContain('后端');
  });

  it('behaves exactly as before when no cache is provided', async () => {
    mockedCall.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'r' }] }],
      }),
    });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://react.dev', title: 'React' }],
      { vocab: emptyVocab, config: modelConfig, local }, // no tagCache
    );
    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
  });
});

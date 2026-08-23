import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';
import {
  aggregateCategoryTopics,
  categorizeBookmarks,
  normalizePlacement,
} from '../functions/_lib/ai/engine';
import { buildFeedbackProfile } from '../functions/_lib/ai/feedback';
import type { AiConfig, Vocabulary } from '../functions/_lib/ai/types';
import { callProvider } from '../functions/_lib/ai/providers';
import type { CategoryCache, CategoryCacheEntry } from '../functions/_lib/ai/url-cache';

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
  fetchContent: false,
  twoPass: false,
};

// A small tree: 开发技术 > {前端开发, 后端开发}, plus 在线工具.
const vocab: Vocabulary = buildVocabulary([
  { name: '开发技术', id: 'dev', aliases: [], count: 30 },
  { name: '前端开发', id: 'fe', aliases: [], count: 12, parentId: 'dev' },
  { name: '后端开发', id: 'be', aliases: [], count: 5, parentId: 'dev' },
  { name: '在线工具', id: 'tools', aliases: [], count: 8 },
]);

const emptyVocab: Vocabulary = buildVocabulary([]);

const MODEL_JSON = JSON.stringify({
  results: [
    {
      i: 1,
      category: '开发技术',
      subcategory: '前端开发',
      confidence: 0.9,
      reason: 'React 官方教程',
      isNew: false,
    },
  ],
});

beforeEach(() => mockedCall.mockReset());
afterEach(() => mockedCall.mockReset());

describe('categorizeBookmarks — basics', () => {
  it('returns an empty none outcome for no input', async () => {
    const out = await categorizeBookmarks([], { vocab: emptyVocab, config: null });
    expect(out.engine).toBe('none');
    expect(out.results).toEqual([]);
    expect(out.fatal).toBe(false);
    expect(out.uncovered).toBe(0);
    expect(out.uncategorized).toBe(0);
  });

  it('uses the domain fallback when no model is configured', async () => {
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo/bar', title: 'A repo' }],
      { vocab: emptyVocab, config: null },
    );
    expect(out.engine).toBe('fallback');
    expect(out.uncovered).toBe(1);
    expect(out.modelError).toContain('域名派生兜底');
    expect(out.results[0].category?.path).toEqual(['GitHub']);
    // C1-5: fallback results are forced into the review queue.
    expect(out.results[0].category?.needsReview).toBe(true);
    expect(out.results[0].category?.source).toBe('fallback');
  });

  it('counts the catch-all 未分类 placement as uncategorized (C1-7)', async () => {
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: '::not a url::', title: 'x' }],
      { vocab: emptyVocab, config: null },
    );
    expect(out.results[0].category?.path).toEqual(['未分类']);
    expect(out.uncategorized).toBe(1);
  });

  it('produces exactly one tree-anchored placement from the model', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_JSON });
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://react.dev/learn', title: 'React 文档' }],
      { vocab, config: modelConfig },
    );
    expect(out.engine).toBe('model');
    expect(out.uncovered).toBe(0);
    expect(out.uncategorized).toBe(0);
    const cat = out.results[0].category;
    expect(cat?.path).toEqual(['开发技术', '前端开发']);
    expect(cat?.tagId).toBe('fe');
    expect(cat?.isNew).toBe(false);
    expect(cat?.source).toBe('model');
    expect(cat?.reason).toBe('React 官方教程');
  });

  it('flags a brand-new category as isNew and routes it to review (C1-3)', async () => {
    const json = JSON.stringify({
      results: [
        { i: 1, category: '量子计算', subcategory: null, confidence: 0.85, reason: '量子主题', isNew: true },
      ],
    });
    mockedCall.mockResolvedValue({ ok: true, text: json });
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://example.com/q', title: 'Quantum' }],
      { vocab, config: modelConfig },
    );
    const cat = out.results[0].category;
    expect(cat?.path).toEqual(['量子计算']);
    expect(cat?.tagId).toBeNull();
    expect(cat?.isNew).toBe(true);
    expect(cat?.needsReview).toBe(true);
  });
});

describe('normalizePlacement — tree anchoring (C1-3)', () => {
  it('lifts a nested node named as top level onto its ancestor chain', () => {
    const n = normalizePlacement({ category: '前端开发', subcategory: null }, vocab);
    expect(n?.path).toEqual(['开发技术', '前端开发']);
    expect(n?.leafTagId).toBe('fe');
    expect(n?.isNew).toBe(false);
  });

  it('keeps a resolved subcategory only under its real parent', () => {
    // 前端开发 lives under 开发技术, not under 在线工具 → dropped, not re-homed.
    const n = normalizePlacement({ category: '在线工具', subcategory: '前端开发' }, vocab);
    expect(n?.path).toEqual(['在线工具']);
    expect(n?.leafTagId).toBe('tools');
  });

  it('allows a new subcategory under an existing top level and flags isNew', () => {
    const n = normalizePlacement({ category: '开发技术', subcategory: '移动开发' }, vocab);
    expect(n?.path).toEqual(['开发技术', '移动开发']);
    expect(n?.leafTagId).toBeNull();
    expect(n?.isNew).toBe(true);
  });

  it('normalises spelling variants onto existing nodes', () => {
    const n = normalizePlacement({ category: 'frontend', subcategory: null }, vocab);
    // No alias registered for 'frontend' → treated as new, canonical spelling kept.
    expect(n?.isNew).toBe(true);
    const exact = normalizePlacement({ category: '开发技术', subcategory: null }, vocab);
    expect(exact?.leafTagId).toBe('dev');
  });
});

describe('categorizeBookmarks — robustness (mirrors the tagging track)', () => {
  it('stops the job on a fatal provider error but still covers bookmarks', async () => {
    mockedCall.mockResolvedValue({ ok: false, error: { status: 401, message: 'API Key 无效' } });
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo/bar', title: 'A repo' }],
      { vocab: emptyVocab, config: modelConfig },
    );
    expect(out.fatal).toBe(true);
    expect(out.modelError).toContain('API Key');
    expect(out.engine).toBe('fallback');
    expect(out.results[0].category?.path).toEqual(['GitHub']);
  });

  it('re-sends only the missing bookmarks (precise compensation)', async () => {
    const onlyB1 = JSON.stringify({
      results: [{ i: 1, category: '开发技术', subcategory: '前端开发', confidence: 0.9, reason: 'r' }],
    });
    const b2 = JSON.stringify({
      results: [{ i: 1, category: '在线工具', subcategory: null, confidence: 0.9, reason: 'r' }],
    });
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: onlyB1 })
      .mockResolvedValueOnce({ ok: true, text: b2 });

    const out = await categorizeBookmarks(
      [
        { id: 'b1', url: 'https://react.dev', title: 'React' },
        { id: 'b2', url: 'https://figma.com', title: 'Figma' },
      ],
      { vocab, config: modelConfig },
    );

    expect(mockedCall.mock.calls.length).toBe(2);
    expect(out.uncovered).toBe(0);
    expect(out.results[0].category?.path).toEqual(['开发技术', '前端开发']);
    expect(out.results[1].category?.path).toEqual(['在线工具']);
  });

  it('recovers a malformed response via the repair turn', async () => {
    const repaired = JSON.stringify({
      results: [{ i: 1, category: '在线工具', subcategory: null, confidence: 0.9, reason: 'r' }],
    });
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: '好的，这是分类结果：' })
      .mockResolvedValueOnce({ ok: true, text: repaired });

    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://figma.com', title: 'Figma' }],
      { vocab, config: modelConfig },
    );

    expect(mockedCall.mock.calls.length).toBe(2);
    expect(out.results[0].category?.path).toEqual(['在线工具']);
  });

  it('degrades to the domain fallback on a permanently unparseable response', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: 'not json at all' });
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo', title: 'A repo' }],
      { vocab: emptyVocab, config: modelConfig },
    );
    expect(out.engine).toBe('fallback');
    expect(out.uncovered).toBe(1);
    expect(out.results[0].category?.path).toEqual(['GitHub']);
  });
});

describe('categorizeBookmarks — category cache', () => {
  function makeCache(hit: CategoryCacheEntry | null): CategoryCache & {
    puts: Array<{ key: string; entry: CategoryCacheEntry }>;
  } {
    const store = new Map<string, CategoryCacheEntry>();
    const puts: Array<{ key: string; entry: CategoryCacheEntry }> = [];
    return {
      puts,
      async get(key) {
        return store.get(key) ?? hit;
      },
      async put(key, entry) {
        store.set(key, entry);
        puts.push({ key, entry });
      },
    };
  }

  it('serves a cached placement without calling the model', async () => {
    const entry: CategoryCacheEntry = {
      category: '在线工具',
      subcategory: null,
      confidence: 0.9,
      reason: '缓存',
      isNew: false,
      needsReview: false,
      source: 'model',
    };
    const cache = makeCache(entry);
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://figma.com', title: 'Figma' }],
      { vocab, config: modelConfig, categoryCache: cache },
    );
    expect(mockedCall).not.toHaveBeenCalled();
    expect(out.engine).toBe('model');
    expect(out.results[0].category?.path).toEqual(['在线工具']);
  });

  it('writes fresh placements back under the ai:cat namespace', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_JSON });
    const cache = makeCache(null);
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://react.dev/learn', title: 'React 文档' }],
      { vocab, config: modelConfig, categoryCache: cache },
    );
    expect(out.results[0].category?.path).toEqual(['开发技术', '前端开发']);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].key).toMatch(/^ai:cat:/);
    expect(cache.puts[0].entry.category).toBe('开发技术');
  });
});

describe('categorizeBookmarks — feedback memory (C1-6)', () => {
  it('drops a placement the user repeatedly rejected on that path', async () => {
    const feedback = buildFeedbackProfile([
      { tagName: '开发技术 > 前端开发', action: 'rejected', domain: 'react.dev' },
      { tagName: '开发技术 > 前端开发', action: 'rejected', domain: 'react.dev' },
      { tagName: '开发技术 > 前端开发', action: 'rejected', domain: 'react.dev' },
    ]);
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_JSON });
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://react.dev/learn', title: 'React 文档' }],
      { vocab, config: modelConfig, feedback },
    );
    // The rejected path is dropped; the domain fallback covers the bookmark.
    expect(out.results[0].category?.source).toBe('fallback');
    expect(out.results[0].category?.path).toEqual(['React']);
  });

  it('boosts a placement the user repeatedly accepted', async () => {
    const feedback = buildFeedbackProfile([
      { tagName: '开发技术 > 前端开发', action: 'accepted', domain: 'react.dev' },
      { tagName: '开发技术 > 前端开发', action: 'accepted', domain: 'react.dev' },
      { tagName: '开发技术 > 前端开发', action: 'accepted', domain: 'react.dev' },
    ]);
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_JSON });
    const out = await categorizeBookmarks(
      [{ id: 'b1', url: 'https://react.dev/learn', title: 'React 文档' }],
      { vocab, config: modelConfig, feedback },
    );
    const cat = out.results[0].category;
    expect(cat?.path).toEqual(['开发技术', '前端开发']);
    expect(cat?.feedbackBoosted).toBe(true);
  });
});

describe('aggregateCategoryTopics', () => {
  it('counts bookmarks by top-level category', () => {
    const topics = aggregateCategoryTopics([
      { bookmarkId: '1', category: { path: ['开发技术', '前端开发'] } as never },
      { bookmarkId: '2', category: { path: ['开发技术', '后端开发'] } as never },
      { bookmarkId: '3', category: { path: ['在线工具'] } as never },
      { bookmarkId: '4', category: null },
    ]);
    expect(topics).toEqual([
      { topic: '开发技术', count: 2 },
      { topic: '在线工具', count: 1 },
    ]);
  });
});

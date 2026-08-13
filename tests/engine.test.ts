import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';
import { suggestForBookmarks } from '../functions/_lib/ai/engine';
import type { AiConfig, LocalConfig, Vocabulary } from '../functions/_lib/ai/types';
import { callProvider } from '../functions/_lib/ai/providers';

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

const emptyVocab: Vocabulary = buildVocabulary([]);

// A model response referencing 1-based index 1.
const MODEL_JSON = JSON.stringify({
  results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'React 文档' }] }],
});

beforeEach(() => mockedCall.mockReset());
afterEach(() => mockedCall.mockReset());

describe('suggestForBookmarks — model-first with domain fallback', () => {
  it('returns an empty none outcome for no input', async () => {
    const out = await suggestForBookmarks([], { vocab: emptyVocab, config: null, local });
    expect(out.engine).toBe('none');
    expect(out.results).toEqual([]);
    expect(out.fatal).toBe(false);
    expect(out.uncovered).toBe(0);
  });

  it('uses the domain fallback when no model is configured', async () => {
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo/bar', title: 'A repo' }],
      { vocab: emptyVocab, config: null, local },
    );
    expect(out.engine).toBe('fallback');
    expect(out.uncovered).toBe(1);
    expect(out.modelError).toContain('域名派生兜底');
    expect(out.results[0].tags.map((t) => t.name)).toContain('GitHub');
    expect(out.results[0].needsReview).toBe(true);
  });

  it('falls back to 未分类 for an unparseable host', async () => {
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: '::not a url::', title: 'x' }],
      { vocab: emptyVocab, config: null, local },
    );
    expect(out.engine).toBe('fallback');
    expect(out.results[0].tags.map((t) => t.name)).toContain('未分类');
  });

  it('runs the model as the sole tag generator when configured', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_JSON });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://example.com/anything', title: 'A page' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    expect(out.engine).toBe('model');
    expect(out.uncovered).toBe(0);
    expect(out.modelError).toBeNull();
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
  });

  it('falls back per-bookmark when the model returns no tags for it', async () => {
    const json = JSON.stringify({ results: [{ i: 1, tags: [] }] });
    mockedCall.mockResolvedValue({ ok: true, text: json });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo', title: 'A repo' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    expect(out.engine).toBe('fallback');
    expect(out.uncovered).toBe(1);
    expect(out.results[0].tags.map((t) => t.name)).toContain('GitHub');
  });

  it('stops the job on a fatal provider error but still produces fallback tags', async () => {
    mockedCall.mockResolvedValue({ ok: false, error: { status: 401, message: 'API Key 无效' } });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo/bar', title: 'A repo' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    expect(out.fatal).toBe(true);
    expect(out.modelError).toContain('API Key');
    expect(out.engine).toBe('fallback');
    expect(out.uncovered).toBe(1);
    expect(out.results[0].tags.map((t) => t.name)).toContain('GitHub');
  });

  it('retries a single transient failure before succeeding', async () => {
    mockedCall
      .mockResolvedValueOnce({ ok: false, error: { status: 429, message: '限流' } })
      .mockResolvedValueOnce({ ok: true, text: MODEL_JSON });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://example.com/anything', title: 'A page' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    expect(mockedCall).toHaveBeenCalledTimes(2);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
  });

  it('does not throw on a malformed model response and degrades to fallback', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: 'not json at all' });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo', title: 'A repo' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    expect(out.engine).toBe('fallback');
    expect(out.results[0].tags.length).toBeGreaterThan(0);
  });

  it('propagates the model topic and needsReview flag into the result', async () => {
    const json = JSON.stringify({
      results: [
        {
          i: 1,
          tags: [{ name: '前端', confidence: 0.9, reason: 'React 文档' }],
          topic: '前端框架',
          needsReview: true,
        },
      ],
    });
    mockedCall.mockResolvedValue({ ok: true, text: json });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://example.com/x', title: 'A page' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    expect(out.results[0].topic).toBe('前端框架');
    expect(out.results[0].needsReview).toBe(true);
  });

  it('counts uncovered bookmarks across a batch', async () => {
    const json = JSON.stringify({
      results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'r' }] }],
    });
    mockedCall.mockResolvedValue({ ok: true, text: json });
    const out = await suggestForBookmarks(
      [
        { id: 'b1', url: 'https://example.com/x', title: 'A page' },
        { id: 'b2', url: 'https://github.com/foo', title: 'A repo' },
        { id: 'b3', url: 'https://gitlab.com/bar', title: 'Another repo' },
      ],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    // b1 got a model tag; b2 and b3 got only the domain fallback.
    expect(out.engine).toBe('model');
    expect(out.uncovered).toBe(2);
    expect(out.results[1].tags.map((t) => t.name)).toContain('GitHub');
    expect(out.results[2].tags.map((t) => t.name)).toContain('GitLab');
  });

  it('uses the top tag as the topic when the model provides none', async () => {
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo/bar', title: 'A repo' }],
      { vocab: emptyVocab, config: null, local },
    );
    expect(out.results[0].topic).toBe('GitHub');
    expect(out.results[0].needsReview).toBe(true);
  });
});

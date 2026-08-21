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
    // First call tags b1 only; compensation re-runs still come back empty, so b2/b3
    // fall back to the domain label. (With precise compensation the engine tries
    // harder, but a model that genuinely returns nothing for them still degrades.)
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: json })
      .mockResolvedValue({ ok: true, text: JSON.stringify({ results: [] }) });
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

describe('suggestForBookmarks — P0-3 precise compensation (no silent drops)', () => {
  it('re-sends only the missing bookmarks and recovers them', async () => {
    // Batch of 3; first call tags b1 only, the compensation re-run returns b2+b3.
    const onlyB1 = JSON.stringify({
      results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'r' }] }],
    });
    const b2b3 = JSON.stringify({
      results: [
        { i: 1, tags: [{ name: '后端', confidence: 0.9, reason: 'r' }] },
        { i: 2, tags: [{ name: '设计', confidence: 0.9, reason: 'r' }] },
      ],
    });
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: onlyB1 })
      .mockResolvedValueOnce({ ok: true, text: b2b3 });

    const out = await suggestForBookmarks(
      [
        { id: 'b1', url: 'https://react.dev', title: 'React' },
        { id: 'b2', url: 'https://nodejs.org', title: 'Node' },
        { id: 'b3', url: 'https://figma.com', title: 'Figma' },
      ],
      { vocab: emptyVocab, config: modelConfig, local },
    );

    // Exactly two model calls: the original batch + the compensation re-run.
    expect(mockedCall.mock.calls.length).toBe(2);
    expect(out.engine).toBe('model');
    expect(out.uncovered).toBe(0);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
    expect(out.results[1].tags.map((t) => t.name)).toContain('后端');
    expect(out.results[2].tags.map((t) => t.name)).toContain('设计');
  });

  it('stops after one compensation re-run and lets the domain fallback cover the rest', async () => {
    const onlyB1 = JSON.stringify({
      results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'r' }] }],
    });
    // First returns b1; the compensation re-run returns nothing (a genuinely
    // quiet model). The engine must not loop forever — it falls back for b2/b3.
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: onlyB1 })
      .mockResolvedValue({ ok: true, text: JSON.stringify({ results: [] }) });

    const out = await suggestForBookmarks(
      [
        { id: 'b1', url: 'https://react.dev', title: 'React' },
        { id: 'b2', url: 'https://github.com/foo', title: 'Repo' },
        { id: 'b3', url: 'https://gitlab.com/bar', title: 'Repo2' },
      ],
      { vocab: emptyVocab, config: modelConfig, local },
    );

    expect(out.engine).toBe('model');
    expect(out.uncovered).toBe(2);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
    expect(out.results[1].tags.map((t) => t.name)).toContain('GitHub');
    expect(out.results[2].tags.map((t) => t.name)).toContain('GitLab');
  });

  it('recovers a malformed-but-meaningful response via the repair turn', async () => {
    // First attempt is prose with no JSON; the repair turn returns valid JSON.
    const repaired = JSON.stringify({
      results: [
        { i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'r' }] },
        { i: 2, tags: [{ name: '后端', confidence: 0.9, reason: 'r' }] },
      ],
    });
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: '好的，这是整理结果：' })
      .mockResolvedValueOnce({ ok: true, text: repaired });

    const out = await suggestForBookmarks(
      [
        { id: 'b1', url: 'https://react.dev', title: 'React' },
        { id: 'b2', url: 'https://nodejs.org', title: 'Node' },
      ],
      { vocab: emptyVocab, config: modelConfig, local },
    );

    // Original attempt + one repair turn.
    expect(mockedCall.mock.calls.length).toBe(2);
    expect(out.engine).toBe('model');
    expect(out.uncovered).toBe(0);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
    expect(out.results[1].tags.map((t) => t.name)).toContain('后端');
  });

  it('accepts a bare array-root response end-to-end', async () => {
    // Some models emit [{i:1,...},{i:2,...}] with no wrapping {results:...}.
    const arrayRoot = JSON.stringify([
      { i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'r' }] },
      { i: 2, tags: [{ name: '后端', confidence: 0.9, reason: 'r' }] },
    ]);
    mockedCall.mockResolvedValueOnce({ ok: true, text: arrayRoot });

    const out = await suggestForBookmarks(
      [
        { id: 'b1', url: 'https://react.dev', title: 'React' },
        { id: 'b2', url: 'https://nodejs.org', title: 'Node' },
      ],
      { vocab: emptyVocab, config: modelConfig, local },
    );

    expect(mockedCall.mock.calls.length).toBe(1);
    expect(out.uncovered).toBe(0);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
    expect(out.results[1].tags.map((t) => t.name)).toContain('后端');
  });

  it('propagates a fatal misconfiguration and stops the job', async () => {
    mockedCall.mockResolvedValueOnce({
      ok: false,
      error: { status: 401, message: 'API Key 无效或无权限' },
    });

    const out = await suggestForBookmarks(
      [
        { id: 'b1', url: 'https://react.dev', title: 'React' },
        { id: 'b2', url: 'https://nodejs.org', title: 'Node' },
      ],
      { vocab: emptyVocab, config: modelConfig, local },
    );

    expect(out.fatal).toBe(true);
    // Remaining bookmarks still get the coverage guarantee, but flagged.
    expect(out.uncovered).toBe(2);
    expect(out.results).toHaveLength(2);
  });
});

describe('suggestForBookmarks — P0-1 taxonomy synthesis', () => {
  it('synthesizes a taxonomy and attaches parent tags when enabled', async () => {
    const tagResults = Array.from({ length: 8 }, (_, i) => ({
      i: i + 1,
      tags: [{ name: `Tag${i}`, confidence: 0.9, reason: 'r' }],
    }));
    const tagJson = JSON.stringify({ results: tagResults });
    const treeJson = JSON.stringify([
      { name: '组A', children: [{ name: 'Tag0' }, { name: 'Tag1' }] },
      { name: '组B', children: [{ name: 'Tag2' }, { name: 'Tag3' }] },
      { name: '其他', children: [{ name: 'Tag4' }, { name: 'Tag5' }, { name: 'Tag6' }, { name: 'Tag7' }] },
    ]);
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: tagJson })
      .mockResolvedValueOnce({ ok: true, text: treeJson });

    const out = await suggestForBookmarks(
      Array.from({ length: 8 }, (_, i) => ({ id: `b${i + 1}`, url: `https://x${i}.com`, title: `X${i}` })),
      { vocab: emptyVocab, config: modelConfig, local, synthesizeTree: true },
    );

    // One tagging call + one tree-synthesis call.
    expect(mockedCall.mock.calls.length).toBe(2);
    expect(out.suggestedTaxonomy).toBeDefined();
    expect(out.suggestedTaxonomy).toHaveLength(3);
    expect(out.results[0].tags.map((t) => t.name)).toContain('组A');
    expect(out.results[2].tags.map((t) => t.name)).toContain('组B');
    expect(out.results[4].tags.map((t) => t.name)).toContain('其他');
  });

  it('does not synthesize (and makes no extra model call) when the option is off', async () => {
    const tagJson = JSON.stringify({
      results: [{ i: 1, tags: [{ name: 'React', confidence: 0.9, reason: 'r' }] }],
    });
    mockedCall.mockResolvedValueOnce({ ok: true, text: tagJson });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://react.dev', title: 'React' }],
      { vocab: emptyVocab, config: modelConfig, local }, // synthesizeTree omitted
    );
    expect(out.suggestedTaxonomy).toBeUndefined();
    expect(mockedCall.mock.calls.length).toBe(1);
  });
});

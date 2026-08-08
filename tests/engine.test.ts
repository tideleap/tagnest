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
  heuristicsEnabled: true,
  maxTags: 4,
};

const local: LocalConfig = {
  autoApplyThreshold: 1,
  heuristicsEnabled: true,
  maxTags: 4,
};

const emptyVocab: Vocabulary = buildVocabulary([]);

// A model response referencing 1-based index 1.
const MODEL_JSON = JSON.stringify({
  results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'React 文档' }] }],
});

beforeEach(() => mockedCall.mockReset());
afterEach(() => mockedCall.mockReset());

describe('suggestForBookmarks — two-track orchestration', () => {
  it('returns an empty none outcome for no input', async () => {
    const out = await suggestForBookmarks([], { vocab: emptyVocab, config: null, local });
    expect(out.engine).toBe('none');
    expect(out.results).toEqual([]);
    expect(out.fatal).toBe(false);
  });

  it('runs heuristics only when no model is configured', async () => {
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo/bar', title: 'A repo' }],
      { vocab: emptyVocab, config: null, local },
    );
    expect(out.engine).toBe('heuristic');
    expect(out.modelError).toContain('本地规则');
    expect(out.results[0].tags.map((t) => t.name)).toContain('开源');
  });

  it('runs the model only when heuristics are switched off', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_JSON });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://example.com/anything', title: 'A page' }],
      { vocab: emptyVocab, config: modelConfig, local: { ...local, heuristicsEnabled: false } },
    );
    expect(out.engine).toBe('model');
    expect(out.modelError).toBeNull();
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
  });

  it('reports mixed when both engines contribute, and keeps both tag sets', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_JSON });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo/bar', title: 'A repo' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    expect(out.engine).toBe('mixed');
    const names = out.results[0].tags.map((t) => t.name);
    expect(names).toContain('开源'); // heuristic
    expect(names).toContain('前端'); // model
  });

  it('stops the job on a fatal provider error but still keeps heuristic output', async () => {
    mockedCall.mockResolvedValue({ ok: false, error: { status: 401, message: 'API Key 无效' } });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo/bar', title: 'A repo' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    expect(out.fatal).toBe(true);
    expect(out.modelError).toContain('API Key');
    // Degradation, not disappearance: heuristics still produced a result.
    expect(out.engine).toBe('heuristic');
    expect(out.results[0].tags.map((t) => t.name)).toContain('开源');
  });

  it('retries a single transient failure before succeeding', async () => {
    mockedCall
      .mockResolvedValueOnce({ ok: false, error: { status: 429, message: '限流' } })
      .mockResolvedValueOnce({ ok: true, text: MODEL_JSON });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://example.com/anything', title: 'A page' }],
      { vocab: emptyVocab, config: modelConfig, local: { ...local, heuristicsEnabled: false } },
    );
    expect(mockedCall).toHaveBeenCalledTimes(2);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
  });

  it('produces nothing when both model and heuristics are unavailable', async () => {
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://example.com/x', title: 'A page' }],
      { vocab: emptyVocab, config: null, local: { ...local, heuristicsEnabled: false } },
    );
    expect(out.engine).toBe('none');
    expect(out.results[0].tags).toEqual([]);
  });

  it('does not throw on a malformed model response', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: 'not json at all' });
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo', title: 'A repo' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    // Heuristics still carry the result; the bad model output is ignored.
    expect(out.engine).toBe('heuristic');
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
      { vocab: emptyVocab, config: modelConfig, local: { ...local, heuristicsEnabled: false } },
    );
    expect(out.results[0].topic).toBe('前端框架');
    expect(out.results[0].needsReview).toBe(true);
  });

  it('falls back to the top tag as topic when the model is absent', async () => {
    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://github.com/foo/bar', title: 'A repo' }],
      { vocab: emptyVocab, config: null, local },
    );
    // Heuristics tag github repos as 开源; with no model there is no topic
    // phrase, so the top tag doubles as the clustering key.
    expect(out.results[0].topic).toBe('开源');
    expect(out.results[0].needsReview).toBe(false);
  });
});

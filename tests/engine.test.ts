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

/**
 * Vocabulary carrying the given names as existing tags (count 10).
 *
 * Tag governance (PRD-TAG-QUALITY) always keeps existing vocabulary tags and
 * drops brand-new singletons, so tests that assert a model tag survives must
 * mark it as existing — otherwise the assertion now measures governance, not
 * the behaviour under test.
 */
function vocabWith(...names: string[]): Vocabulary {
  return buildVocabulary(
    names.map((name, i) => ({ id: `t${i}`, name, aliases: [], count: 10 })),
  );
}

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
      // Existing-vocab tags survive governance; the test measures compensation.
      { vocab: vocabWith('前端', '后端', '设计'), config: modelConfig, local },
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
      // 前端 is an existing tag so it survives governance; b2/b3 fall back.
      { vocab: vocabWith('前端'), config: modelConfig, local },
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
      // Existing-vocab tags survive governance; the test measures repair.
      { vocab: vocabWith('前端', '后端'), config: modelConfig, local },
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
      // Existing-vocab tags survive governance; the test measures parsing.
      { vocab: vocabWith('前端', '后端'), config: modelConfig, local },
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

describe('suggestForBookmarks — zero-usable-tags repair turn (no silent empty tags)', () => {
  it('fires the repair turn when the response parses but every tag list is empty, and surfaces the raw text when the repair is also empty', async () => {
    // Parseable JSON, yet zero usable tags — the exact shape that used to skip
    // the repair turn and silently degrade every bookmark to the domain fallback.
    const emptyJson = JSON.stringify({
      results: [{ i: 1, tags: [] }, { i: 2, tags: [] }],
    });
    mockedCall.mockResolvedValue({ ok: true, text: emptyJson });

    const out = await suggestForBookmarks(
      [
        { id: 'b1', url: 'https://react.dev', title: 'React' },
        { id: 'b2', url: 'https://nodejs.org', title: 'Node' },
      ],
      { vocab: emptyVocab, config: modelConfig, local },
    );

    // The repair turn was triggered (original call + at least one repair call).
    expect(mockedCall.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The repair prompt demands at least one concrete tag per bookmark.
    const repairPrompt = mockedCall.mock.calls[1][1] as string;
    expect(repairPrompt).toContain('至少输出 1 个');
    // The error bubbles up to the outcome carrying the model's raw response.
    expect(out.modelError).not.toBeNull();
    expect(out.modelError).toContain('模型原文');
    expect(out.modelError).toContain('"tags":[]');
    // Coverage guarantee still holds: both bookmarks fall back, flagged.
    expect(out.engine).toBe('fallback');
    expect(out.uncovered).toBe(2);
    expect(out.results.every((r) => r.tags.length >= 1)).toBe(true);
  });

  it('adopts the repair turn result when it finally carries tags', async () => {
    const emptyJson = JSON.stringify({ results: [{ i: 1, tags: [] }] });
    const repaired = JSON.stringify({
      results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'r' }] }],
    });
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: emptyJson })
      .mockResolvedValueOnce({ ok: true, text: repaired });

    const out = await suggestForBookmarks(
      [{ id: 'b1', url: 'https://react.dev', title: 'React' }],
      // Existing-vocab tag survives governance; the test measures the repair.
      { vocab: vocabWith('前端'), config: modelConfig, local },
    );

    expect(mockedCall.mock.calls.length).toBe(2);
    expect(out.engine).toBe('model');
    expect(out.modelError).toBeNull();
    expect(out.uncovered).toBe(0);
    expect(out.results[0].tags.map((t) => t.name)).toContain('前端');
  });
});

describe('suggestForBookmarks — P0-1 taxonomy synthesis', () => {  it('synthesizes a taxonomy and attaches parent tags when enabled', async () => {
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
      // Existing-vocab tags survive governance so synthesis sees all 8 names.
      {
        vocab: vocabWith(...Array.from({ length: 8 }, (_, i) => `Tag${i}`)),
        config: modelConfig,
        local,
        synthesizeTree: true,
      },
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

describe('suggestForBookmarks — tag governance integration (PRD-TAG-QUALITY)', () => {
  it('governs fragment tags across the whole batch: singletons demoted for review, supported tag kept', async () => {
    // 4 bookmarks each proposing a unique one-off tag, plus 2 bookmarks
    // sharing one tag. minSupport=2: the shared tag survives; the four
    // one-off names are demoted (kept at reduced confidence, flagged for
    // review) instead of being deleted — the model's verdict stays visible.
    const json = JSON.stringify({
      results: [
        { i: 1, tags: [{ name: '孤词甲', confidence: 0.9, reason: 'r' }] },
        { i: 2, tags: [{ name: '孤词乙', confidence: 0.9, reason: 'r' }] },
        { i: 3, tags: [{ name: '孤词丙', confidence: 0.9, reason: 'r' }] },
        { i: 4, tags: [{ name: '孤词丁', confidence: 0.9, reason: 'r' }] },
        { i: 5, tags: [{ name: '常用主题', confidence: 0.8, reason: 'r' }] },
        { i: 6, tags: [{ name: '常用主题', confidence: 0.8, reason: 'r' }] },
      ],
    });
    mockedCall.mockResolvedValueOnce({ ok: true, text: json });
    const out = await suggestForBookmarks(
      Array.from({ length: 6 }, (_, i) => ({
        id: `b${i + 1}`,
        url: `https://site${i}.example.com/page`,
        title: `Page ${i}`,
      })),
      { vocab: emptyVocab, config: modelConfig, local },
    );
    const allNames = out.results.flatMap((r) => r.tags.map((t) => t.name));
    // The supported tag survives on its holders...
    expect(allNames).toContain('常用主题');
    // ...and every one-off name stays visible, demoted for human review.
    for (const frag of ['孤词甲', '孤词乙', '孤词丙', '孤词丁']) {
      expect(allNames).toContain(frag);
    }
    // Demoted holders are flagged needsReview so the review queue — not a
    // threshold — decides whether the tag survives.
    for (const r of out.results) {
      if (r.tags.some((t) => ['孤词甲', '孤词乙', '孤词丙', '孤词丁'].includes(t.name))) {
        expect(r.needsReview).toBe(true);
        expect(r.tags.find((t) => ['孤词甲', '孤词乙', '孤词丙', '孤词丁'].includes(t.name))!.reason).toContain('人工确认');
      }
    }
    // No bookmark left untagged (fallback guarantee) and metrics surfaced.
    expect(out.results.every((r) => r.tags.length >= 1)).toBe(true);
    expect(out.governance).not.toBeNull();
    expect(out.governance!.metrics.budget).toBeGreaterThan(0);
    expect(out.governance!.metrics.demoted).toBe(4);
    expect(out.governance!.metrics.dropped).toBe(0);
    // Fallback re-seeding is no longer needed: nothing was deleted.
    expect(out.uncovered).toBe(0);
  });

  it('P0-6: writes GOVERNED tags to the URL cache, not the raw model output', async () => {
    // 1 bookmark carries a true singleton fragment (support 1 → demoted with
    // review flag since 2026-08-30, not deleted); 4 bookmarks share a
    // supported keeper tag.
    const json = JSON.stringify({
      results: [
        { i: 1, tags: [{ name: '孤立碎片词', confidence: 0.9, reason: 'r' }] },
        { i: 2, tags: [{ name: '共享主题', confidence: 0.8, reason: 'r' }] },
        { i: 3, tags: [{ name: '共享主题', confidence: 0.8, reason: 'r' }] },
        { i: 4, tags: [{ name: '共享主题', confidence: 0.8, reason: 'r' }] },
        { i: 5, tags: [{ name: '共享主题', confidence: 0.8, reason: 'r' }] },
      ],
    });
    mockedCall.mockResolvedValueOnce({ ok: true, text: json });

    const store = new Map<string, unknown>();
    const cache = {
      get: vi.fn(async () => null),
      put: vi.fn(async (key: string, entry: unknown) => {
        store.set(key, entry);
      }),
    };

    await suggestForBookmarks(
      Array.from({ length: 5 }, (_, i) => ({
        id: `b${i + 1}`,
        url: `https://u${i}.example.com/p`,
        title: `U${i}`,
      })),
      { vocab: emptyVocab, config: modelConfig, local, tagCache: cache },
    );

    // The fragment URL IS cached under the new demotion semantics, but the
    // demoted tag carries the review flag so a cache replay cannot resurrect
    // it as a fully-trusted suggestion.
    const entries = [...store.values()] as Array<{
      tags: Array<{ name: string; confidence: number; reason: string }>;
      needsReview: boolean;
    }>;
    const fragmentEntry = entries.find((e) =>
      e.tags.some((t) => t.name === '孤立碎片词'),
    );
    expect(fragmentEntry).toBeDefined();
    expect(fragmentEntry!.needsReview).toBe(true);
    expect(fragmentEntry!.tags.find((t) => t.name === '孤立碎片词')!.reason).toContain(
      '人工确认',
    );
    expect(fragmentEntry!.tags.find((t) => t.name === '孤立碎片词')!.confidence).toBeCloseTo(0.54, 5);
    // The supported tag is present in the cached sets that had it.
    const withShared = entries.filter((e) => e.tags.some((t) => t.name === '共享主题'));
    expect(withShared.length).toBe(4);
    // All 5 URLs are cached now — nothing was governed away.
    expect(entries.length).toBe(5);
  });

  it('P0-5: prompt states the run-size budget line', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: JSON.stringify({ results: [] }) });
    await suggestForBookmarks(
      Array.from({ length: 30 }, (_, i) => ({
        id: `b${i}`,
        url: `https://x${i}.example.com/`,
        title: `X${i}`,
      })),
      { vocab: emptyVocab, config: modelConfig, local },
    );
    const prompt = mockedCall.mock.calls[0][1] as string;
    expect(prompt).toContain('【硬性要求】');
    expect(prompt).toContain('共 30 条书签');
    expect(prompt).toContain('不超过 10 个');
  });
});

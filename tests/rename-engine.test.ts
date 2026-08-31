import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renameBookmarks } from '../functions/_lib/ai/engine';
import type { AiConfig } from '../functions/_lib/ai/types';
import { callProvider } from '../functions/_lib/ai/providers';
import type { RenameCache, RenameCacheEntry } from '../functions/_lib/ai/url-cache';

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

beforeEach(() => mockedCall.mockReset());
afterEach(() => mockedCall.mockReset());

/** One model row for bookmark #i (1-based). */
function row(i: number, title: string, opts: { reason?: string; unchanged?: boolean } = {}) {
  return { i, title, reason: opts.reason ?? 'r', unchanged: opts.unchanged ?? false };
}

describe('renameBookmarks — basics', () => {
  it('returns an empty none outcome for no input', async () => {
    const out = await renameBookmarks([], { config: null });
    expect(out).toEqual({ results: [], engine: 'none', modelError: null, fatal: false, unchanged: 0, adultQuarantined: 0 });
  });

  it('skips the model without a config and reports why', async () => {
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: '首页' }],
      { config: null },
    );
    expect(out.engine).toBe('none');
    expect(out.modelError).toContain('未配置可用的模型');
    expect(out.results[0].rename).toBeNull();
    expect(out.unchanged).toBe(1);
  });

  it('produces a candidate from the model with the original title echoed', async () => {
    mockedCall.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ results: [row(1, 'GitHub')] }),
    });
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: 'GitHub · Where the world builds software' }],
      { config: modelConfig },
    );
    expect(out.engine).toBe('model');
    expect(out.fatal).toBe(false);
    expect(out.modelError).toBeNull();
    expect(out.results[0].rename).toEqual({
      original: 'GitHub · Where the world builds software',
      title: 'GitHub',
      reason: 'r',
    });
    expect(out.unchanged).toBe(0);
  });

  it('honours the autoTag master switch: off means no model, no suggestions', async () => {
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: '首页' }],
      { config: { ...modelConfig, autoTag: false } },
    );
    expect(mockedCall).not.toHaveBeenCalled();
    expect(out.engine).toBe('none');
    expect(out.results[0].rename).toBeNull();
  });
});

describe('renameBookmarks — deterministic guards', () => {
  it('turns an unchanged verdict into no-suggestion', async () => {
    mockedCall.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ results: [row(1, 'React 官方文档', { unchanged: true })] }),
    });
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://react.dev', title: 'React 官方文档' }],
      { config: modelConfig },
    );
    expect(out.results[0].rename).toBeNull();
    expect(out.unchanged).toBe(1);
  });

  it('drops a proposal that equals the current title (whitespace tolerated)', async () => {
    mockedCall.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ results: [row(1, '  GitHub  ')] }),
    });
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: 'GitHub' }],
      { config: modelConfig },
    );
    expect(out.results[0].rename).toBeNull();
    expect(out.unchanged).toBe(1);
  });

  it('counts a row without a usable answer as unchanged, not a failure', async () => {
    mockedCall.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ results: [row(1, '')] }),
    });
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: '首页' }],
      { config: modelConfig },
    );
    expect(out.results[0].rename).toBeNull();
    expect(out.unchanged).toBe(1);
    expect(out.fatal).toBe(false);
  });
});

describe('renameBookmarks — robustness (mirrors the other tracks)', () => {
  it('stops the job on a fatal provider error', async () => {
    mockedCall.mockResolvedValue({ ok: false, error: { status: 401, message: 'API Key 无效' } });
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: '首页' }],
      { config: modelConfig },
    );
    expect(out.fatal).toBe(true);
    expect(out.modelError).toContain('API Key');
    expect(out.results[0].rename).toBeNull();
  });

  it('recovers a malformed response via the repair turn', async () => {
    const repaired = JSON.stringify({ results: [row(1, 'GitHub')] });
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: '好的，这是清理结果：' })
      .mockResolvedValueOnce({ ok: true, text: repaired });

    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: 'GitHub · Slogan' }],
      { config: modelConfig },
    );
    expect(mockedCall.mock.calls.length).toBe(2);
    // The repair prompt asks for strict JSON.
    expect(String(mockedCall.mock.calls[1][1])).toContain('无法解析为 JSON');
    expect(out.results[0].rename?.title).toBe('GitHub');
  });

  it('re-sends only the missing bookmarks (precise compensation)', async () => {
    const onlyB1 = JSON.stringify({ results: [row(1, 'GitHub')] });
    const b2 = JSON.stringify({ results: [row(1, 'Figma')] });
    mockedCall
      .mockResolvedValueOnce({ ok: true, text: onlyB1 })
      .mockResolvedValueOnce({ ok: true, text: b2 });

    const out = await renameBookmarks(
      [
        { id: 'b1', url: 'https://github.com/', title: 'GitHub · Slogan' },
        { id: 'b2', url: 'https://figma.com/', title: '首页' },
      ],
      { config: modelConfig },
    );
    expect(mockedCall.mock.calls.length).toBe(2);
    expect(out.results[0].rename?.title).toBe('GitHub');
    expect(out.results[1].rename?.title).toBe('Figma');
    expect(out.unchanged).toBe(0);
  });

  it('keeps a permanently unparseable response non-fatal (no local fallback for rename)', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: 'not json at all' });
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: '首页' }],
      { config: modelConfig },
    );
    expect(out.fatal).toBe(false);
    expect(out.results[0].rename).toBeNull();
    expect(out.unchanged).toBe(1);
    // Two calls: original + repair turn.
    expect(mockedCall.mock.calls.length).toBe(2);
  });
});

describe('renameBookmarks — rename cache (ai:rename: namespace)', () => {
  function makeCache(hit: RenameCacheEntry | null): RenameCache & {
    puts: Array<{ key: string; entry: RenameCacheEntry }>;
  } {
    const store = new Map<string, RenameCacheEntry>();
    const puts: Array<{ key: string; entry: RenameCacheEntry }> = [];
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

  it('serves a cached verdict without calling the model', async () => {
    const cache = makeCache({ title: 'GitHub', reason: '缓存', unchanged: false });
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: 'GitHub · Slogan' }],
      { config: modelConfig, renameCache: cache },
    );
    expect(mockedCall).not.toHaveBeenCalled();
    expect(out.engine).toBe('model');
    expect(out.results[0].rename?.title).toBe('GitHub');
  });

  it('re-checks a cached answer against the CURRENT title', async () => {
    // The cache proposes "GitHub", but the user has since edited the title
    // to exactly that — the stale answer must NOT become a suggestion.
    const cache = makeCache({ title: 'GitHub', reason: '缓存', unchanged: false });
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: 'GitHub' }],
      { config: modelConfig, renameCache: cache },
    );
    expect(mockedCall).not.toHaveBeenCalled();
    expect(out.results[0].rename).toBeNull();
    expect(out.unchanged).toBe(1);
  });

  it('caches even unchanged verdicts so a re-run never re-bills', async () => {
    mockedCall.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ results: [row(1, 'React 官方文档', { unchanged: true })] }),
    });
    const cache = makeCache(null);
    await renameBookmarks(
      [{ id: 'b1', url: 'https://react.dev', title: 'React 官方文档' }],
      { config: modelConfig, renameCache: cache },
    );
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].key).toMatch(/^ai:rename:/);
    expect(cache.puts[0].entry).toMatchObject({ unchanged: true });
  });

  it('writes fresh proposals back under the ai:rename: namespace', async () => {
    mockedCall.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ results: [row(1, 'GitHub')] }),
    });
    const cache = makeCache(null);
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: 'GitHub · Slogan' }],
      { config: modelConfig, renameCache: cache },
    );
    expect(out.results[0].rename?.title).toBe('GitHub');
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].key).toMatch(/^ai:rename:/);
    expect(cache.puts[0].entry).toMatchObject({ title: 'GitHub', unchanged: false });
  });

  it('does not write back when the model call was fatal', async () => {
    mockedCall.mockResolvedValue({ ok: false, error: { status: 401, message: 'API Key 无效' } });
    const cache = makeCache(null);
    const out = await renameBookmarks(
      [{ id: 'b1', url: 'https://github.com/', title: '首页' }],
      { config: modelConfig, renameCache: cache },
    );
    expect(out.fatal).toBe(true);
    expect(cache.puts).toHaveLength(0);
  });
});

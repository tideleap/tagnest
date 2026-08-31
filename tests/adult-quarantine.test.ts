// tests/adult-quarantine.test.ts
//
// Adult-content quarantine (2026-08-30).
//
// A single adult bookmark inside a batch can make a safety-aligned model refuse
// the whole batch — it answers with a refusal (or empty tags) instead of JSON,
// the parser yields nothing, and the entire slice silently degrades to domain
// fallback. The fix quarantines obviously-adult bookmarks BEFORE they reach the
// model: they never enter the prompt, they get one deterministic neutral tag /
// placement, and they wait in the review queue.
//
// These tests pin down:
//   1. looksAdult() boundary behaviour (conservative — 宁漏勿错).
//   2. All three engine tracks (tag / categorize / rename) quarantine correctly:
//      the adult bookmark is excluded from the model, gets the neutral label,
//      and is flagged needsReview; the rest of the batch still reaches the model.
//   3. autoApply respects needs_review so quarantined rows never auto-apply.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';
import {
  categorizeBookmarks,
  renameBookmarks,
  suggestForBookmarks,
} from '../functions/_lib/ai/engine';
import { looksAdult, ADULT_TAG_NAME, ADULT_QUARANTINE_CONFIDENCE } from '../functions/_lib/ai/adult';
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
  fetchContent: false,
  twoPass: false,
};

const local: LocalConfig = {
  autoApplyThreshold: 1,
  maxTags: 4,
};

const emptyVocab: Vocabulary = buildVocabulary([]);

/**
 * Vocabulary carrying the given names as existing tags (count 10).
 *
 * Tag governance always keeps existing vocabulary tags but drops brand-new
 * singletons (minSupport=2), so any model tag a test asserts must survive must
 * be marked existing — otherwise the assertion measures governance, not the
 * quarantine behaviour under test. (Mirrors engine.test.ts convention.)
 */
function vocabWith(...names: string[]): Vocabulary {
  return buildVocabulary(
    names.map((name, i) => ({ id: `t${i}`, name, aliases: [], count: 10 })),
  );
}

// A model response for one non-adult bookmark (index 1 in the model-bound batch).
const MODEL_TAG_JSON = JSON.stringify({
  results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'React 文档' }] }],
});

const MODEL_CAT_JSON = JSON.stringify({
  results: [{ i: 1, category: '开发技术', subcategory: '前端开发', confidence: 0.9, reason: 'React' }],
});

const MODEL_RENAME_JSON = JSON.stringify({
  results: [{ i: 1, title: 'React 文档', reason: '去掉后缀', unchanged: false }],
});

beforeEach(() => mockedCall.mockReset());
afterEach(() => mockedCall.mockReset());

/* ------------------------------------------------------------------ *
 * 1. looksAdult() boundary behaviour
 * ------------------------------------------------------------------ */
describe('looksAdult — conservative heuristic', () => {
  it('matches a well-known adult domain exactly', () => {
    expect(looksAdult({ url: 'https://pornhub.com/view', title: 'x' })).toBe(true);
    expect(looksAdult({ url: 'https://www.pornhub.com/view', title: 'x' })).toBe(true);
  });

  it('matches a sub-domain of a known adult domain', () => {
    expect(looksAdult({ url: 'https://de.pornhub.com/view', title: 'x' })).toBe(true);
    expect(looksAdult({ url: 'https://cdn.xvideos.com/a', title: 'x' })).toBe(true);
  });

  it('does NOT match a domain that merely contains an adult word as a substring', () => {
    // "essex" contains "sex" but is a place name; must not quarantine.
    expect(looksAdult({ url: 'https://essex.gov.uk/council', title: 'Essex Council' })).toBe(false);
    expect(looksAdult({ url: 'https://middlesex.water.ca/', title: 'Middlesex Water' })).toBe(false);
  });

  it('matches explicit ASCII title keywords at word boundaries', () => {
    expect(looksAdult({ url: 'https://example.com/a', title: 'best porn sites' })).toBe(true);
    expect(looksAdult({ url: 'https://example.com/a', title: 'NSFW thread' })).toBe(true);
    expect(looksAdult({ url: 'https://example.com/a', title: 'hentai gallery' })).toBe(true);
  });

  it('does NOT match ASCII keywords embedded inside a longer word', () => {
    // "porn" inside "popcorn" must not match (word boundary).
    expect(looksAdult({ url: 'https://example.com/a', title: 'popcorn time app' })).toBe(false);
  });

  it('matches unambiguous CJK adult markers', () => {
    expect(looksAdult({ url: 'https://example.com/a', title: '成人视频网站' })).toBe(true);
    expect(looksAdult({ url: 'https://example.com/a', title: '色情电影' })).toBe(true);
  });

  it('returns false for ordinary bookmarks', () => {
    expect(looksAdult({ url: 'https://github.com/foo/bar', title: 'A repo' })).toBe(false);
    expect(looksAdult({ url: 'https://react.dev/learn', title: 'React 文档' })).toBe(false);
    expect(looksAdult({ url: 'https://example.com', title: '' })).toBe(false);
  });

  it('handles an unparseable URL gracefully (falls back to title only)', () => {
    expect(looksAdult({ url: '::not a url::', title: 'normal page' })).toBe(false);
    expect(looksAdult({ url: '::not a url::', title: '成人直播' })).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 2a. Tagging track quarantine
 * ------------------------------------------------------------------ */
describe('suggestForBookmarks — adult quarantine', () => {
  it('quarantines an adult bookmark and still models the rest', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_TAG_JSON });
    const out = await suggestForBookmarks(
      [
        { id: 'adult', url: 'https://pornhub.com/view_video', title: 'x' },
        { id: 'clean', url: 'https://react.dev/learn', title: 'React 文档' },
      ],
      { vocab: vocabWith('前端'), config: modelConfig, local },
    );

    expect(out.adultQuarantined).toBe(1);
    expect(out.engine).toBe('model');

    // The adult bookmark got the deterministic neutral tag, flagged for review.
    const adult = out.results.find((r) => r.bookmarkId === 'adult')!;
    expect(adult.tags.map((t) => t.name)).toContain(ADULT_TAG_NAME);
    expect(adult.needsReview).toBe(true);
    expect(adult.topic).toBe(ADULT_TAG_NAME);

    // The clean bookmark still reached the model and got a real tag.
    const clean = out.results.find((r) => r.bookmarkId === 'clean')!;
    expect(clean.tags.map((t) => t.name)).toContain('前端');
  });

  it('never sends the adult bookmark to the model (prompt excludes it)', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_TAG_JSON });
    await suggestForBookmarks(
      [
        { id: 'adult', url: 'https://xvideos.com/video', title: 'x' },
        { id: 'clean', url: 'https://react.dev/learn', title: 'React 文档' },
      ],
      { vocab: emptyVocab, config: modelConfig, local },
    );

    // Exactly one model call, and its prompt must NOT contain the adult URL.
    expect(mockedCall).toHaveBeenCalledTimes(1);
    const promptArg = mockedCall.mock.calls[0][1] as string;
    expect(promptArg).not.toContain('xvideos.com');
    expect(promptArg).toContain('react.dev');
  });

  it('quarantines even when no model is configured (fallback path)', async () => {
    const out = await suggestForBookmarks(
      [{ id: 'adult', url: 'https://pornhub.com/view', title: 'x' }],
      { vocab: emptyVocab, config: null, local },
    );
    expect(out.adultQuarantined).toBe(1);
    const adult = out.results[0];
    expect(adult.tags.map((t) => t.name)).toContain(ADULT_TAG_NAME);
    expect(adult.needsReview).toBe(true);
  });

  it('stamps a bounded (never overstated) confidence on the neutral tag', async () => {
    const out = await suggestForBookmarks(
      [{ id: 'adult', url: 'https://pornhub.com/view', title: 'x' }],
      { vocab: emptyVocab, config: null, local },
    );
    const tag = out.results[0].tags.find((t) => t.name === ADULT_TAG_NAME)!;
    // Resolution may re-score the candidate (new-node discount), so the exact
    // value is not the contract — only that it never EXCEEDS the quarantine
    // confidence and stays a sane probability. The real gate is needsReview.
    expect(tag.confidence).toBeGreaterThan(0);
    expect(tag.confidence).toBeLessThanOrEqual(ADULT_QUARANTINE_CONFIDENCE);
    expect(out.results[0].needsReview).toBe(true);
  });

  it('reports zero quarantine for a fully clean batch', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_TAG_JSON });
    const out = await suggestForBookmarks(
      [{ id: 'clean', url: 'https://react.dev/learn', title: 'React 文档' }],
      { vocab: emptyVocab, config: modelConfig, local },
    );
    expect(out.adultQuarantined).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2b. Categorize track quarantine
 * ------------------------------------------------------------------ */
describe('categorizeBookmarks — adult quarantine', () => {
  it('quarantines an adult bookmark into a 「成人内容」 placement', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_CAT_JSON });
    const out = await categorizeBookmarks(
      [
        { id: 'adult', url: 'https://pornhub.com/view_video', title: 'x' },
        { id: 'clean', url: 'https://react.dev/learn', title: 'React 文档' },
      ],
      { vocab: emptyVocab, config: modelConfig },
    );

    expect(out.adultQuarantined).toBe(1);

    const adult = out.results.find((r) => r.bookmarkId === 'adult')!;
    expect(adult.category?.path).toEqual([ADULT_TAG_NAME]);
    expect(adult.category?.needsReview).toBe(true);
    expect(adult.category?.confidence).toBe(ADULT_QUARANTINE_CONFIDENCE);

    // The clean bookmark still got a model placement. The sub-category name may
    // be canonicalised by the synonym table (前端开发 → 前端), so assert the
    // top-level category and that a path landed rather than the exact leaf
    // spelling. (needsReview may be true here because the path is brand-new on
    // an empty vocab — that is normal new-node behaviour, unrelated to quarantine.)
    const clean = out.results.find((r) => r.bookmarkId === 'clean')!;
    expect(clean.category?.path?.[0]).toBe('开发技术');
    expect((clean.category?.path?.length ?? 0) >= 1).toBe(true);
  });

  it('never sends the adult bookmark to the model', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_CAT_JSON });
    await categorizeBookmarks(
      [
        { id: 'adult', url: 'https://xhamster.com/video', title: 'x' },
        { id: 'clean', url: 'https://react.dev/learn', title: 'React 文档' },
      ],
      { vocab: emptyVocab, config: modelConfig },
    );
    expect(mockedCall).toHaveBeenCalledTimes(1);
    const promptArg = mockedCall.mock.calls[0][1] as string;
    expect(promptArg).not.toContain('xhamster.com');
  });
});

/* ------------------------------------------------------------------ *
 * 2c. Rename track quarantine
 * ------------------------------------------------------------------ */
describe('renameBookmarks — adult quarantine', () => {
  it('quarantines an adult bookmark (title left untouched) and models the rest', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_RENAME_JSON });
    const out = await renameBookmarks(
      [
        { id: 'adult', url: 'https://pornhub.com/view_video', title: 'some adult title' },
        { id: 'clean', url: 'https://react.dev/learn', title: 'React 文档 | 官方' },
      ],
      { config: modelConfig },
    );

    expect(out.adultQuarantined).toBe(1);

    // The adult bookmark's title is untouched (no rename suggestion).
    const adult = out.results.find((r) => r.bookmarkId === 'adult')!;
    expect(adult.rename).toBeNull();

    // The clean bookmark still got a rename suggestion from the model.
    const clean = out.results.find((r) => r.bookmarkId === 'clean')!;
    expect(clean.rename?.title).toBe('React 文档');
  });

  it('never sends the adult bookmark to the model', async () => {
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_RENAME_JSON });
    await renameBookmarks(
      [
        { id: 'adult', url: 'https://onlyfans.com/creator', title: 'x' },
        { id: 'clean', url: 'https://react.dev/learn', title: 'React 文档 | 官方' },
      ],
      { config: modelConfig },
    );
    expect(mockedCall).toHaveBeenCalledTimes(1);
    const promptArg = mockedCall.mock.calls[0][1] as string;
    expect(promptArg).not.toContain('onlyfans.com');
  });
});

/* ------------------------------------------------------------------ *
 * 3. Whole-batch resilience: one adult must not sink the batch
 * ------------------------------------------------------------------ */
describe('quarantine prevents whole-batch refusal', () => {
  it('a mixed batch still yields model tags for the clean bookmarks', async () => {
    // Simulate the model answering ONLY for the clean bookmark (index 1 in the
    // model-bound sub-batch, since the adult one was removed).
    mockedCall.mockResolvedValue({ ok: true, text: MODEL_TAG_JSON });
    const out = await suggestForBookmarks(
      [
        { id: 'adult', url: 'https://pornhub.com/view', title: 'x' },
        { id: 'clean', url: 'https://react.dev/learn', title: 'React 文档' },
      ],
      { vocab: vocabWith('前端'), config: modelConfig, local },
    );

    // The clean bookmark must NOT have degraded to domain fallback.
    const clean = out.results.find((r) => r.bookmarkId === 'clean')!;
    expect(clean.tags.map((t) => t.name)).toContain('前端');
    // And the run is not reported as uncovered for the clean one.
    expect(out.uncovered).toBe(0);
  });
});

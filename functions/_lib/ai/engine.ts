import { domainFallbackTag } from './domain-fallback';
import { enrichInputsWithContent } from './enrich';
import {
  BATCH_SIZE,
  buildCategorizePrompt,
  buildCoarsePrompt,
  buildTaggingPrompt,
  parseCategorizeResponse,
  parseCoarseResponse,
  parseTaggingResponse,
  type CategorizeExample,
  type Example,
  type ParsedCategory,
  type ParsedCategorizeItem,
} from './prompt';
import { callProvider, isFatal, isRetryable, withRetry } from './providers';
import { normalizeKey, resolveCandidates, resolveTagName } from './taxonomy';
import { attachParentTags, synthesizeTaxonomy, type TaxonomyNode } from './taxonomy-tree';
import {
  cacheKeyFor,
  categoryCacheKeyFor,
  type CategoryCache,
  type CategoryCacheEntry,
  type TagCache,
  type TagCacheEntry,
} from './url-cache';
import {
  LEXICAL_BONUS,
  MIN_FALLBACK_CONFIDENCE,
  MIN_MODEL_CONFIDENCE,
  lexicalEvidence,
  sameHostBoost,
  scoreTagCandidate,
  tagFrequencyFactor,
  vocabularyEntryFor,
} from './scoring';
import { feedbackMultiplier, renameByFeedback, type FeedbackProfile } from './feedback';
import { hostOf } from '../urlkey';
import type { AiConfig, CandidateSource, EnrichInput, LocalConfig, RawCandidate, TagCandidate, Vocabulary } from './types';
import type { AiTopicCount } from '../../../shared/types';

/**
 * The orchestrator: turns bookmarks into reviewed-ready tag proposals.
 *
 * ## Model-first, with a coverage safety net
 *
 * The model is the sole tag generator. The local rule engine (`heuristics`) and
 * the naive-Bayes classifier were removed — a deliberate simplification decided
 * after evaluating the local tagging strategy (see docs/AI-HIERARCHY.md §评估):
 * keeping them meant maintaining two engines, a consensus bonus, and a silent
 * downgrade path, all for coverage the model now owns. When the model is
 * unavailable, or returns nothing for a bookmark, a minimal **domain-derived
 * fallback** (`domainFallbackTag`) guarantees the bookmark still receives at
 * least one tag. Those fallback proposals are flagged `needsReview` and counted
 * in `SuggestOutcome.uncovered`, so "no model output" is never silent and never
 * leaves a bookmark untagged.
 */

export interface BookmarkInput extends EnrichInput {
  id: string;
}

export interface SuggestionResult {
  bookmarkId: string;
  tags: TagCandidate[];
  summary: string | null;
  topic: string | null;
  needsReview: boolean;
}

export type EngineKind = 'model' | 'fallback' | 'none';

export interface SuggestOutcome {
  results: SuggestionResult[];
  /** Which engine actually produced the output — surfaced so a fallback is visible. */
  engine: EngineKind;
  /** Human-readable reason the model did not contribute, if it did not. */
  modelError: string | null;
  /** True when the caller should stop the whole job (bad key, missing model). */
  fatal: boolean;
  /** Number of bookmarks that received only the domain fallback (no model tag). */
  uncovered: number;
  /**
   * The consistent hierarchy synthesized from the batch's tag frequencies (P0-1),
   * when `synthesizeTree` was enabled and enough signal existed. Undefined when
   * synthesis was off or produced nothing — never an error to omit it.
   */
  suggestedTaxonomy?: TaxonomyNode[];
}

export interface SuggestOptions {
  vocab: Vocabulary;
  /** Null when no model is available; the domain fallback still runs. */
  config: AiConfig | null;
  local: LocalConfig;
  feedback?: FeedbackProfile | null;
  fetchImpl?: typeof fetch;
  /**
   * Few-shot examples drawn from the user's own well-tagged bookmarks (方案B).
   * When omitted or empty the prompt falls back to its built-in defaults.
   */
  examples?: Example[];
  /**
   * P0-1: synthesize a consistent classification tree from the batch's tag
   * frequencies and attach each tag's parent category (opt-in, default off so
   * existing behaviour is unchanged until explicitly enabled).
   */
  synthesizeTree?: boolean;
  /**
   * P1-2: per-URL result cache. When present, URLs the model has already tagged
   * (same prompt version + model) are served from cache and skip the model
   * entirely; fresh results are written back. Absent ⇒ always call the model.
   */
  tagCache?: TagCache;
}

/**
 * How deep the precise-compensation recursion may go when the model returns a
 * partial batch. Depth 1 means: one re-run of the missing bookmarks; if those
 * still come back incomplete we stop and let the per-bookmark fallback cover the
 * rest. Bounding it keeps call counts predictable and avoids an exponential
 * re-send on a consistently failing model.
 */
const COMPENSATE_DEPTH = 1;

/**
 * Calls the model for one tagging batch, retrying transient failures, then — if the
 * response parses to nothing — fires a single "strict JSON only" repair turn
 * before giving up. This recovers the common malformed-but-meaningful responses
 * (prose preamble, markdown fences, truncated tail) that used to drop the whole
 * batch to the fallback path.
 */
async function callTagWithRetryAndRepair(
  config: AiConfig,
  prompt: string,
  batchSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ items: import('./prompt').ParsedItem[]; fatal: boolean; error: string | null }> {
  const result = await withRetry(
    () => callProvider(config, prompt, fetchImpl),
    (outcome) => {
      if (outcome.ok) return 'ok';
      if (isFatal(outcome.error)) return 'stop';
      if (isRetryable(outcome.error)) return 'retry';
      return 'stop';
    },
  );

  if (!result.ok) {
    // Stop without further retries: the error is fatal or not worth retrying.
    return { items: [], fatal: isFatal(result.error), error: result.error?.message ?? '模型调用失败' };
  }

  // Successful response: parse it, and if it yields nothing, fire one strict-JSON
  // repair turn before giving up (recovers prose/fenced/truncated responses).
  let items = parseTaggingResponse(result.text, batchSize);
  if (items.length === 0) {
    const repairOutcome = await callProvider(
      config,
      `${prompt}\n\n注意：刚才的回复无法解析为 JSON。请严格只输出合法 JSON（不要 markdown 代码块、不要解释文字），以 { 或 [ 开头。`,
      fetchImpl,
    );
    if (repairOutcome.ok && typeof repairOutcome.text === 'string') {
      const repaired = parseTaggingResponse(repairOutcome.text, batchSize);
      if (repaired.length > 0) items = repaired;
    }
  }
  return { items, fatal: false, error: null };
}

/**
 * Tags a group of bookmarks (a subset of one batch) and guarantees completeness
 * via precise compensation: if the model returns fewer items than requested, the
 * missing bookmarks are re-sent alone (recursively, up to COMPENSATE_DEPTH) so
 * they receive a real tag instead of silently falling back. This is the direct
 * fix for "分类不够全面" — a truncated or partial response no longer drops
 * bookmarks. When the model is fatally misconfigured the failure propagates so
 * the job stops and reports why.
 */
async function tagGroup(
  group: BookmarkInput[],
  localIndices: number[],
  depth: number,
  opts: {
    config: AiConfig;
    vocab: Vocabulary;
    local: LocalConfig;
    wantSummary: boolean;
    coarseTopics?: Array<string | null>;
    examples?: Example[];
    fetchImpl?: typeof fetch;
  },
): Promise<{ items: Map<number, import('./prompt').ParsedItem>; fatal: boolean; error: string | null }> {
  const out = new Map<number, import('./prompt').ParsedItem>();
  if (group.length === 0) return { items: out, fatal: false, error: null };

  const prompt = buildTaggingPrompt(group, opts.vocab, {
    maxTags: opts.local.maxTags,
    wantSummary: opts.wantSummary,
    coarseTopics: opts.coarseTopics,
    examples: opts.examples,
  });

  const { items, fatal, error } = await callTagWithRetryAndRepair(opts.config, prompt, group.length, opts.fetchImpl);
  if (fatal) return { items: out, fatal: true, error };

  for (const item of items) {
    const li = localIndices[item.index];
    if (li !== undefined) out.set(li, item);
  }

  const missing = localIndices.filter((li) => !out.has(li));
  if (missing.length > 0 && missing.length < localIndices.length && depth < COMPENSATE_DEPTH) {
    const missingInputs = missing.map((li) => group[localIndices.indexOf(li)]);
    const sub = await tagGroup(missingInputs, missing, depth + 1, opts);
    if (sub.fatal) return { items: out, fatal: true, error: sub.error };
    for (const [li, item] of sub.items) out.set(li, item);
  }
  return { items: out, fatal: false, error: null };
}

/**
 * Produces suggestions for a set of bookmarks.
 *
 * Safe to call with anything from one bookmark to a few dozen; the model track
 * chunks internally at `BATCH_SIZE`. Never throws — a failing model degrades to
 * the domain fallback and reports why.
 */
export async function suggestForBookmarks(
  inputs: BookmarkInput[],
  options: SuggestOptions,
): Promise<SuggestOutcome> {
  if (inputs.length === 0) {
    return { results: [], engine: 'none', modelError: null, fatal: false, uncovered: 0 };
  }

  const { vocab, config, local } = options;
  const feedback = options.feedback ?? null;

  // ---- The model track (sole generator) -------------------------------
  const modelTags = new Map<number, RawCandidate[]>();
  const summaries = new Map<number, string>();
  /** Bookmark index → topic phrase (model-supplied, used for clustering). */
  const topics = new Map<number, string>();
  /** Bookmark index → whether the model flagged the proposal as uncertain. */
  const needsReviewFlags = new Map<number, boolean>();
  let modelError: string | null = null;
  let modelContributed = false;
  let fatal = false;
  /** P0-1 synthesized hierarchy, when synthesis ran and produced a tree. */
  let suggestedTaxonomy: TaxonomyNode[] | undefined;

  const wantModel = Boolean(config && (config.autoTag || config.autoSummarize));

  if (wantModel && config) {
    // 方案A: fetch page content so the model classifies real text, not just a
    // title. Runs once for the whole input set (bounded concurrency, hard
    // timeouts); failures leave the input untouched and the pipeline proceeds.
    const enriched = config.fetchContent
      ? await enrichInputsWithContent(inputs, options.fetchImpl)
      : inputs;

    // Shared applier: writes one parsed item (fresh model output or cache hit)
    // into the per-bookmark maps the normalisation pass reads from.
    const applyItem = (globalIndex: number, item: TagCacheEntry) => {
      if (config.autoTag && item.tags.length > 0) {
        modelContributed = true;
        modelTags.set(
          globalIndex,
          item.tags.map((tag) => ({
            name: tag.name,
            confidence: tag.confidence,
            source: 'model' as const,
            reason: tag.reason,
          })),
        );
      }
      if (config.autoSummarize && item.summary) {
        modelContributed = true;
        summaries.set(globalIndex, item.summary);
      }
      // Topic + review-flag are per-bookmark attributes; capture them once
      // regardless of how many tags the model proposed.
      if (item.topic) topics.set(globalIndex, item.topic);
      if (item.needsReview) needsReviewFlags.set(globalIndex, true);
    };

    // P1-2: serve cache hits directly; only uncached URLs go to the model.
    // Keys fold in prompt version + model, so a prompt bump invalidates
    // automatically. Lookups run in parallel — one round trip, not N.
    const cache = options.tagCache;
    const pending: Array<{ input: BookmarkInput; globalIndex: number; key: string }> = [];
    if (cache) {
      const keys = await Promise.all(enriched.map((input) => cacheKeyFor(input.url, config.model)));
      const hits = await Promise.all(keys.map((key) => cache.get(key)));
      enriched.forEach((input, index) => {
        const hit = hits[index];
        if (hit) applyItem(index, hit);
        else pending.push({ input, globalIndex: index, key: keys[index] });
      });
    } else {
      enriched.forEach((input, index) => pending.push({ input, globalIndex: index, key: '' }));
    }

    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const slice = pending.slice(start, start + BATCH_SIZE);
      const sliceInputs = slice.map((p) => p.input);

      // 方案E: optional coarse pass. One cheap call per batch produces a topic
      // judgement that anchors the fine pass, improving tag granularity.
      let coarseTopics: Array<string | null> | undefined;
      if (config.twoPass) {
        const coarsePrompt = buildCoarsePrompt(sliceInputs);
        const outcome = await withRetry(
          () => callProvider(config, coarsePrompt, options.fetchImpl),
          (o) => {
            if (o.ok) return 'ok';
            if (isFatal(o.error)) return 'stop';
            if (isRetryable(o.error)) return 'retry';
            return 'stop';
          },
        );
        if (outcome.ok) {
          coarseTopics = parseCoarseResponse(outcome.text, sliceInputs.length);
        } else if (isFatal(outcome.error)) {
          fatal = true;
          modelError = outcome.error.message;
        }
        if (fatal) break;
      }

      // 方案E 两轮：若开启两轮分类，先用粗分结果锚定本轮打标。
      const groupResult = await tagGroup(
        sliceInputs,
        sliceInputs.map((_, k) => k),
        0,
        {
          config,
          vocab,
          local,
          wantSummary: config.autoSummarize,
          coarseTopics,
          examples: options.examples,
          fetchImpl: options.fetchImpl,
        },
      );
      if (groupResult.fatal) {
        fatal = true;
        if (groupResult.error) modelError = groupResult.error;
        break;
      }

      for (const [localIdx, item] of groupResult.items) {
        const globalIndex = slice[localIdx].globalIndex;
        applyItem(globalIndex, item);
        // P1-2 write-back: remember this URL's result so a re-analysis of the
        // same page skips the model. Empty results are NOT cached — a quiet
        // model this time should not poison the next run.
        if (cache && (item.tags.length > 0 || item.summary)) {
          await cache.put(slice[localIdx].key, {
            tags: item.tags,
            summary: item.summary,
            topic: item.topic,
            needsReview: item.needsReview,
          });
        }
      }
    }

    // P0-1: synthesise a consistent hierarchy from the batch's tag frequencies
    // and attach each tag's parent category, so independent per-bookmark tags
    // stop fragmenting into a flat pile ("补父标签").
    if (options.synthesizeTree) {
      const tagCounts = new Map<string, number>();
      for (const cands of modelTags.values()) {
        for (const cand of cands) {
          tagCounts.set(cand.name, (tagCounts.get(cand.name) ?? 0) + 1);
        }
      }
      if (tagCounts.size >= 8) {
        const counts = [...tagCounts.entries()].map(([name, count]) => ({ name, count }));
        const synth = await synthesizeTaxonomy(counts, config, options.fetchImpl);
        if (synth.fatal) {
          fatal = true;
          if (synth.error) modelError = synth.error;
        } else if (synth.tree.length > 0) {
          suggestedTaxonomy = synth.tree;
          for (const [index, cands] of modelTags) {
            modelTags.set(index, attachParentTags(cands, synth.tree));
          }
        }
      }
    }
  } else if (!config) {
    modelError = '未配置可用的模型，使用域名派生兜底标签';
  }

  // ---- Normalise, rank, score, and guarantee coverage -----------------
  let uncovered = 0;
  const results: SuggestionResult[] = inputs.map((input, index) => {
    // Apply the user's rename history before resolution: a tag they have
    // repeatedly switched ("React" → "React.js") is proposed under their
    // preferred spelling, so resolution can merge it with the right existing
    // tag rather than inventing a near-duplicate.
    const raw: RawCandidate[] = (modelTags.get(index) ?? []).map((c) => {
      if (!feedback) return c;
      const renamed = renameByFeedback(c.name, feedback);
      if (renamed === c.name) return c;
      return { ...c, name: renamed, reason: `按你以往偏好改用「${renamed}」` };
    });

    let resolved = raw.length > 0 ? resolveCandidates(raw, vocab, local.maxTags) : [];

    // Coverage guarantee: a bookmark with no model tag still gets exactly one
    // domain-derived fallback tag, flagged for review.
    let needsReview = needsReviewFlags.get(index) ?? false;
    if (resolved.length === 0) {
      const fb = domainFallbackTag(input);
      if (fb) {
        resolved = resolveCandidates([fb], vocab, local.maxTags);
        needsReview = true;
        uncovered += 1;
      }
    }

    // Multi-dimensional scoring pass: fold in the user's tag-usage frequency,
    // the page's own lexical evidence, and the same-host neighbourhood signal.
    // Drop anything that falls below the confidence floor.
    const hostBoostCache = (name: string) => sameHostBoost(inputs, index, name);
    const scored: TagCandidate[] = [];
    for (const candidate of resolved) {
      const vocabEntry = vocabularyEntryFor(vocab, candidate.tagId, candidate.name);
      const boosted = scoreTagCandidate(
        candidate,
        input,
        hostBoostCache(candidate.name),
        vocabEntry,
        feedback,
      );
      if (boosted) scored.push(boosted);
    }
    scored.sort((a, b) => b.confidence - a.name.localeCompare(b.name));

    // Prefer the model's own topic phrase; fall back to the top resolved tag
    // so the in-job topic distribution is still populated for fallback runs.
    const topic = topics.get(index) ?? (scored.length > 0 ? scored[0].name : null);

    return {
      bookmarkId: input.id,
      tags: scored.slice(0, Math.max(1, local.maxTags)),
      summary: summaries.get(index) ?? null,
      topic,
      needsReview,
    };
  });

  let engine: EngineKind = 'none';
  if (modelContributed) engine = 'model';
  else if (uncovered > 0) engine = 'fallback';

  return { results, engine, modelError, fatal, uncovered, suggestedTaxonomy };
}

/**
 * Counts bookmarks by their model-assigned topic across a chunk of results.
 *
 * Used to build the post-run topic distribution chart: each result is one
 * bookmark carrying a single `topic`, so the count is the number of bookmarks
 * that fell under that topic. `null` topics are dropped — they carry no
 * signal for the chart.
 */
export function aggregateTopics(results: SuggestionResult[]): AiTopicCount[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    if (!result.topic) continue;
    counts.set(result.topic, (counts.get(result.topic) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

/* ================================================================== *
 * Categorize mode (CategorySync P1 — C1-1/C1-2/C1-4/C1-5/C1-6/C1-7)
 *
 * Tagging asks "which labels fit?"; categorizing asks "which single folder
 * does this bookmark belong in?". The orchestration below mirrors the tagging
 * track on purpose — same retry/repair turn, same precise compensation, same
 * cache discipline, same domain-fallback safety net — so a categorize run
 * inherits every robustness win the tagging pipeline earned. What differs is
 * the shape of the result: exactly one tree-anchored placement per bookmark,
 * never a tag cloud.
 * ================================================================== */

/** One bookmark's unique placement proposal (the review-queue payload). */
export interface CategoryCandidate {
  /**
   * Full category path after tree normalisation, 1–3 levels
   * (e.g. ["开发技术", "前端开发"]). Join with " > " for display/storage.
   */
  path: string[];
  /** Existing tag id of the deepest path node; null = the leaf must be created. */
  tagId: string | null;
  /** 0..1, already scored (reuse, lexical, host, feedback signals folded in). */
  confidence: number;
  source: CandidateSource;
  /** Short human-readable justification, shown in the review UI. */
  reason: string;
  /** True when at least one path level does not exist yet (C1-3: enters review). */
  isNew: boolean;
  needsReview: boolean;
  /** Set when the user's feedback history lifted this placement's confidence. */
  feedbackBoosted?: boolean;
}

export interface CategorizeResult {
  bookmarkId: string;
  /** Never null in practice — the domain fallback guarantees a row; typed nullable for safety. */
  category: CategoryCandidate | null;
}

export interface CategorizeOutcome {
  results: CategorizeResult[];
  engine: EngineKind;
  modelError: string | null;
  fatal: boolean;
  /** Bookmarks that received only the domain fallback (no model placement). */
  uncovered: number;
  /**
   * C1-7 metric: bookmarks whose final placement is the catch-all 「未分类」 —
   * no model output AND no parseable host signal. These need a human.
   */
  uncategorized: number;
}

export interface CategorizeOptions {
  vocab: Vocabulary;
  /** Null when no model is available; the domain fallback still runs. */
  config: AiConfig | null;
  feedback?: FeedbackProfile | null;
  fetchImpl?: typeof fetch;
  /** Few-shot examples; the prompt defaults to its built-in categorize set. */
  examples?: CategorizeExample[];
  /**
   * Per-URL categorize cache (`ai:cat:` namespace). Optional exactly like
   * `tagCache`: absent ⇒ always call the model.
   */
  categoryCache?: CategoryCache;
}

/** The catch-all placement name `domainFallbackTag` uses for unparseable hosts. */
const UNCATEGORIZED_NAME = '未分类';

/**
 * Calls the model for one categorize batch with the same retry + repair-turn
 * discipline as tagging: transient failures retry, fatal errors stop, and a
 * response that parses to nothing earns one strict-JSON repair turn.
 */
async function callCategorizeWithRetryAndRepair(
  config: AiConfig,
  prompt: string,
  batchSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ items: ParsedCategorizeItem[]; fatal: boolean; error: string | null }> {
  const result = await withRetry(
    () => callProvider(config, prompt, fetchImpl),
    (outcome) => {
      if (outcome.ok) return 'ok';
      if (isFatal(outcome.error)) return 'stop';
      if (isRetryable(outcome.error)) return 'retry';
      return 'stop';
    },
  );

  if (!result.ok) {
    return { items: [], fatal: isFatal(result.error), error: result.error?.message ?? '模型调用失败' };
  }

  let items = parseCategorizeResponse(result.text, batchSize);
  if (items.length === 0) {
    const repairOutcome = await callProvider(
      config,
      `${prompt}\n\n注意：刚才的回复无法解析为 JSON。请严格只输出合法 JSON（不要 markdown 代码块、不要解释文字），以 { 或 [ 开头。`,
      fetchImpl,
    );
    if (repairOutcome.ok && typeof repairOutcome.text === 'string') {
      const repaired = parseCategorizeResponse(repairOutcome.text, batchSize);
      if (repaired.length > 0) items = repaired;
    }
  }
  return { items, fatal: false, error: null };
}

/**
 * Categorizes a group of bookmarks and guarantees completeness via precise
 * compensation — identical policy to `tagGroup`: a partial response re-sends
 * only the missing bookmarks (up to COMPENSATE_DEPTH), so a truncated answer
 * does not silently drop placements.
 */
async function categorizeGroup(
  group: BookmarkInput[],
  localIndices: number[],
  depth: number,
  opts: {
    config: AiConfig;
    vocab: Vocabulary;
    examples?: CategorizeExample[];
    fetchImpl?: typeof fetch;
  },
): Promise<{ items: Map<number, ParsedCategorizeItem>; fatal: boolean; error: string | null }> {
  const out = new Map<number, ParsedCategorizeItem>();
  if (group.length === 0) return { items: out, fatal: false, error: null };

  const prompt = buildCategorizePrompt(group, opts.vocab, { examples: opts.examples });
  const { items, fatal, error } = await callCategorizeWithRetryAndRepair(
    opts.config,
    prompt,
    group.length,
    opts.fetchImpl,
  );
  if (fatal) return { items: out, fatal: true, error };

  for (const item of items) {
    const li = localIndices[item.index];
    if (li !== undefined) out.set(li, item);
  }

  const missing = localIndices.filter((li) => !out.has(li));
  if (missing.length > 0 && missing.length < localIndices.length && depth < COMPENSATE_DEPTH) {
    const missingInputs = missing.map((li) => group[localIndices.indexOf(li)]);
    const sub = await categorizeGroup(missingInputs, missing, depth + 1, opts);
    if (sub.fatal) return { items: out, fatal: true, error: sub.error };
    for (const [li, item] of sub.items) out.set(li, item);
  }
  return { items: out, fatal: false, error: null };
}

/**
 * Normalises a raw model placement against the user's tree (C1-3).
 *
 * Rules, each deliberate:
 *  - Both levels pass the 4-pass `resolveTagName` normalisation, so spelling
 *    variants land on existing nodes instead of splitting the tree.
 *  - **Lift**: if the model named a nested node as the top level (e.g.
 *    "前端开发" which lives under "开发技术"), the ancestor chain is prepended.
 *    The stored placement derives its path by walking `parent_id`, so the
 *    suggestion must show that same path — never a shorter one.
 *  - **Consistency**: a resolved subcategory is kept only when it is an
 *    existing child of the resolved top level, or a brand-new node (which is
 *    flagged `isNew` and enters review). An existing node with a different
 *    parent is dropped rather than silently re-homed.
 *  - Depth is capped at 3 levels (mapping rule R6).
 */
export function normalizePlacement(
  parsed: Pick<ParsedCategory, 'category' | 'subcategory'>,
  vocab: Vocabulary,
): { path: string[]; leafTagId: string | null; isNew: boolean; reuseFactor: number } | null {
  const top = resolveTagName(parsed.category, vocab);
  if (!top) return null;

  const byId = new Map(vocab.entries.map((e) => [e.id, e]));

  let path: string[] = [top.name];
  let leafTagId = top.tagId;
  let isNew = top.tagId === null;
  let reuseFactor = top.confidenceFactor;

  // Lift a nested "top level" onto its real ancestor chain.
  if (top.tagId) {
    const ancestors: string[] = [];
    let cursor = byId.get(top.tagId);
    while (cursor?.parentId && ancestors.length < 2) {
      const parent = byId.get(cursor.parentId);
      if (!parent) break;
      ancestors.unshift(parent.name);
      cursor = parent;
    }
    if (ancestors.length > 0) path = [...ancestors, ...path];
  }

  if (parsed.subcategory) {
    const sub = resolveTagName(parsed.subcategory, vocab);
    if (sub) {
      let keep = false;
      if (sub.tagId && top.tagId) {
        keep = byId.get(sub.tagId)?.parentId === top.tagId;
      } else if (!sub.tagId) {
        // A new child under the resolved top level — allowed, review-flagged.
        keep = true;
      }
      if (keep && path.length < 3) {
        path.push(sub.name);
        leafTagId = sub.tagId;
        if (!sub.tagId) isNew = true;
        // The weaker resolution governs: a path is only as solid as its weakest node.
        reuseFactor = Math.min(reuseFactor, sub.confidenceFactor);
      }
    }
  }

  return { path, leafTagId, isNew, reuseFactor };
}

/**
 * Scores a normalised placement with the same multi-dimensional signals tagging
 * uses (C1-6), adapted to the path shape:
 *   1. reuse factor from normalisation (existing nodes beat new ones);
 *   2. frequency factor of the deepest existing node;
 *   3. lexical evidence for the top-level name in the bookmark's own text;
 *   4. same-host neighbourhood boost;
 *   5. feedback memory keyed by the *path string* — this is the C1-6 extension
 *      from (tag, domain) to (category path, domain); the profile aggregates by
 *      normalised name, and a path joined with " > " is simply a longer name.
 * Returns null when the placement falls below the confidence floor.
 */
function scorePlacement(
  parsed: ParsedCategory & { source?: CandidateSource },
  normalized: { path: string[]; leafTagId: string | null; isNew: boolean; reuseFactor: number },
  input: BookmarkInput,
  inputs: BookmarkInput[],
  index: number,
  vocab: Vocabulary,
  feedback: FeedbackProfile | null,
): { confidence: number; feedbackBoosted: boolean } | null {
  let confidence = parsed.confidence * normalized.reuseFactor;

  // Frequency of the deepest existing node: a well-used branch is a safer bet.
  if (normalized.leafTagId) {
    const entry = vocab.entries.find((e) => e.id === normalized.leafTagId);
    if (entry) confidence *= tagFrequencyFactor(entry.count);
  }

  // Lexical evidence for the top-level category in the page's own text.
  const topLevel = normalized.path[0];
  const lex = topLevel ? lexicalEvidence(input, topLevel) : null;
  if (lex != null && lex > 0) confidence += LEXICAL_BONUS * lex;

  // Same-host neighbourhood (pages from one site tend to share a category).
  if (topLevel) confidence *= sameHostBoost(inputs, index, topLevel);

  // Feedback memory on the path string (C1-6).
  let feedbackBoosted = false;
  if (feedback) {
    const pathKey = normalizeKey(normalized.path.join(' > '));
    const domain = hostOf(input.url);
    const pathEffect = feedbackMultiplier(feedback.byTag.get(pathKey));
    if (pathEffect.drop) return null;
    let mult = pathEffect.mult;
    if (domain) {
      const pdEffect = feedbackMultiplier(feedback.byTagDomain.get(`${pathKey}|${domain}`));
      if (pdEffect.drop) return null;
      if (pdEffect.mult > mult) mult = pdEffect.mult;
    }
    if (mult !== 1) {
      confidence = Math.min(1, Math.max(0, confidence * mult));
      if (mult > 1) feedbackBoosted = true;
    }
  }

  const capped = Math.min(1, Math.max(0, confidence));
  const floor = parsed.source === 'fallback' ? MIN_FALLBACK_CONFIDENCE : MIN_MODEL_CONFIDENCE;
  if (capped < floor) return null;

  return { confidence: capped, feedbackBoosted };
}

/**
 * Produces a unique primary-category proposal for every input bookmark.
 *
 * Mirrors `suggestForBookmarks` in robustness: never throws; a failing model
 * degrades to the domain fallback and reports why; a fatally misconfigured
 * model stops the job via `fatal`. Coverage semantics:
 *  - `uncovered`  — bookmarks that got only the domain fallback;
 *  - `uncategorized` — bookmarks stuck on the catch-all 「未分类」 (C1-7 metric).
 */
export async function categorizeBookmarks(
  inputs: BookmarkInput[],
  options: CategorizeOptions,
): Promise<CategorizeOutcome> {
  if (inputs.length === 0) {
    return {
      results: [],
      engine: 'none',
      modelError: null,
      fatal: false,
      uncovered: 0,
      uncategorized: 0,
    };
  }

  const { vocab, config } = options;
  const feedback = options.feedback ?? null;

  const placements = new Map<number, ParsedCategory>();
  const needsReviewFlags = new Map<number, boolean>();
  let modelError: string | null = null;
  let modelContributed = false;
  let fatal = false;

  // Categorizing is content-first (C1-2): the model track runs whenever a
  // model is configured. `autoTag` is the user's master switch for AI
  // organisation; summarisation is irrelevant here.
  const wantModel = Boolean(config && config.autoTag);

  if (wantModel && config) {
    const enriched = config.fetchContent
      ? await enrichInputsWithContent(inputs, options.fetchImpl)
      : inputs;

    const applyItem = (globalIndex: number, entry: CategoryCacheEntry) => {
      modelContributed = true;
      placements.set(globalIndex, entry);
      if (entry.needsReview) needsReviewFlags.set(globalIndex, true);
    };

    // Cache-first: URLs already categorized under this prompt version + model
    // skip the model entirely. Lookups run in parallel — one round trip.
    const cache = options.categoryCache;
    const pending: Array<{ input: BookmarkInput; globalIndex: number; key: string }> = [];
    if (cache) {
      const keys = await Promise.all(enriched.map((input) => categoryCacheKeyFor(input.url, config.model)));
      const hits = await Promise.all(keys.map((key) => cache.get(key)));
      enriched.forEach((input, index) => {
        const hit = hits[index];
        if (hit) applyItem(index, hit);
        else pending.push({ input, globalIndex: index, key: keys[index] });
      });
    } else {
      enriched.forEach((input, index) => pending.push({ input, globalIndex: index, key: '' }));
    }

    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const slice = pending.slice(start, start + BATCH_SIZE);
      const sliceInputs = slice.map((p) => p.input);

      const groupResult = await categorizeGroup(sliceInputs, sliceInputs.map((_, k) => k), 0, {
        config,
        vocab,
        examples: options.examples,
        fetchImpl: options.fetchImpl,
      });
      if (groupResult.fatal) {
        fatal = true;
        if (groupResult.error) modelError = groupResult.error;
        break;
      }

      for (const [localIdx, item] of groupResult.items) {
        const globalIndex = slice[localIdx].globalIndex;
        if (!item.category) continue; // row parsed but unusable → fallback path below
        const entry: CategoryCacheEntry = { ...item.category, source: 'model' as const };
        applyItem(globalIndex, entry);
        // Write-back: remember this URL's placement. Usability is guaranteed
        // by the fallback anyway, so caching a real placement is always safe.
        if (cache) await cache.put(slice[localIdx].key, entry);
      }
    }
  } else if (!config) {
    modelError = '未配置可用的模型，使用域名派生兜底分类';
  }

  // ---- Normalise, score, and guarantee a placement for every bookmark ----
  let uncovered = 0;
  let uncategorized = 0;

  const results: CategorizeResult[] = inputs.map((input, index) => {
    let candidate: CategoryCandidate | null = null;

    const modelParsed = placements.get(index);
    if (modelParsed) {
      // Apply the user's rename history to the whole path before resolution:
      // a path they have switched before is proposed under their preferred
      // spelling, so resolution merges it with the right existing nodes.
      let working = modelParsed;
      if (feedback) {
        const rawPath = [modelParsed.category, modelParsed.subcategory].filter(Boolean).join(' > ');
        const renamed = renameByFeedback(rawPath, feedback);
        if (renamed !== rawPath) {
          const parts = renamed.split('>').map((p) => p.trim()).filter(Boolean);
          working = {
            ...modelParsed,
            category: parts[0] ?? modelParsed.category,
            subcategory: parts.length > 1 ? parts.slice(1).join(' > ') : null,
            reason: `按你以往偏好改用「${renamed}」`,
          };
        }
      }

      const normalized = normalizePlacement(working, vocab);
      if (normalized && normalized.path.length > 0) {
        const scored = scorePlacement(working, normalized, input, inputs, index, vocab, feedback);
        if (scored) {
          candidate = {
            path: normalized.path,
            tagId: normalized.leafTagId,
            confidence: scored.confidence,
            source: 'model',
            reason: working.reason,
            isNew: normalized.isNew,
            needsReview: needsReviewFlags.get(index) ?? normalized.isNew,
            feedbackBoosted: scored.feedbackBoosted || undefined,
          };
        }
      }
    }

    // Coverage guarantee: no usable model placement → domain-derived fallback,
    // flagged for review (C1-5 forces fallback results into the queue).
    if (!candidate) {
      const fb = domainFallbackTag(input);
      if (fb) {
        const normalized = normalizePlacement({ category: fb.name, subcategory: null }, vocab);
        const path = normalized && normalized.path.length > 0 ? normalized.path : [fb.name];
        const parsedFb: ParsedCategory & { source: CandidateSource } = {
          category: fb.name,
          subcategory: null,
          confidence: fb.confidence,
          reason: fb.reason,
          isNew: false,
          needsReview: true,
          source: 'fallback',
        };
        const scored = scorePlacement(
          parsedFb,
          normalized ?? { path, leafTagId: null, isNew: false, reuseFactor: 1 },
          input,
          inputs,
          index,
          vocab,
          feedback,
        );
        candidate = {
          path,
          tagId: normalized?.leafTagId ?? null,
          confidence: scored?.confidence ?? fb.confidence,
          source: 'fallback',
          reason: fb.reason,
          isNew: normalized?.isNew ?? true,
          needsReview: true,
        };
        uncovered += 1;
      }
    }

    if (candidate && candidate.path.length === 1 && candidate.path[0] === UNCATEGORIZED_NAME) {
      uncategorized += 1;
    }

    return { bookmarkId: input.id, category: candidate };
  });

  let engine: EngineKind = 'none';
  if (modelContributed) engine = 'model';
  else if (uncovered > 0) engine = 'fallback';

  return { results, engine, modelError, fatal, uncovered, uncategorized };
}

/**
 * Category distribution across a categorize chunk, keyed by top-level category.
 * Feeds the same post-run distribution UI `aggregateTopics` serves for tagging.
 */
export function aggregateCategoryTopics(results: CategorizeResult[]): AiTopicCount[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    const top = result.category?.path[0];
    if (!top) continue;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

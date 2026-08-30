import { domainFallbackTag } from './domain-fallback';
import { canonicalSiteLabel } from './site-label';
import { enrichInputsWithContent } from './enrich';
import {
  BATCH_SIZE,
  buildCategorizePrompt,
  buildCoarsePrompt,
  buildRenamePrompt,
  buildTaggingPrompt,
  parseCategorizeResponse,
  parseCoarseResponse,
  parseRenameResponse,
  parseTaggingResponse,
  MAX_CATEGORY_DEPTH,
  makeParsedCategory,
  type CategorizeExample,
  type Example,
  type ParsedCategory,
  type ParsedCategorizeItem,
} from './prompt';
import { callProvider, isFatal, isTransientRetryable, withRetry } from './providers';
import { normalizeKey, resolveCandidates, resolveTagName } from './taxonomy';
import { attachParentTags, synthesizeTaxonomy, type TaxonomyNode } from './taxonomy-tree';
import { governTaxonomy, type GovernResult } from './governance';
import {
  cacheKeyFor,
  categoryCacheKeyFor,
  renameCacheKeyFor,
  type CategoryCache,
  type CategoryCacheEntry,
  type RenameCache,
  type RenameCacheEntry,
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
import type { AiConfig, CandidateSource, EnrichInput, LocalConfig, RawCandidate, TagCandidate, VocabEntry, Vocabulary } from './types';
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
  /**
   * Tag-quality governance result (PRD-TAG-QUALITY-2026-08-30): quality card
   * and rescue metrics. Null when governance did not run (no model output).
   */
  governance?: GovernResult | null;
}

export interface SuggestOptions {
  vocab: Vocabulary;
  /** Null when no model is available; the domain fallback still runs. */
  config: AiConfig | null;
  local: LocalConfig;
  feedback?: FeedbackProfile | null;
  fetchImpl?: typeof fetch;
  /**
   * Optional abort signal bounding the *whole* per-partition model budget (set
   * by `/run` from `TN_PARTITION_BUDGET_MS`). When present it is merged with the
   * per-call `REQUEST_TIMEOUT_MS` so a partition can never outlive the Cloudflare
   * Functions wall-clock even if the model is slow.
   */
  signal?: AbortSignal;
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
  signal?: AbortSignal,
): Promise<{ items: import('./prompt').ParsedItem[]; fatal: boolean; error: string | null }> {
  const result = await withRetry(
    () => callProvider(config, prompt, fetchImpl, signal),
    (outcome) => {
      if (outcome.ok) return 'ok';
      if (isFatal(outcome.error)) return 'stop';
      if (isTransientRetryable(outcome.error)) return 'retry';
      return 'stop';
    },
    {},
    signal,
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
      `${prompt}\n\n注意：刚才的回复无法解析为 JSON 或返回了空标签。请严格只输出合法 JSON（不要 markdown 代码块、不要解释文字），以 { 或 [ 开头。`,
      fetchImpl,
      signal,
    );
    if (repairOutcome.ok && typeof repairOutcome.text === 'string') {
      const repaired = parseTaggingResponse(repairOutcome.text, batchSize);
      if (repaired.length > 0) items = repaired;
    }
  }
  if (items.length === 0) {
    return {
      items: [],
      fatal: false,
      error: '模型返回了空标签（可能是提示规则过于严格或模型拒绝生成）',
    };
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
    signal?: AbortSignal;
    /** Whole-run size, for the prompt's distinct-tag budget line (P0-5). */
    totalInputs?: number;
  },
): Promise<{ items: Map<number, import('./prompt').ParsedItem>; fatal: boolean; error: string | null }> {
  const out = new Map<number, import('./prompt').ParsedItem>();
  if (group.length === 0) return { items: out, fatal: false, error: null };

  const prompt = buildTaggingPrompt(group, opts.vocab, {
    maxTags: opts.local.maxTags,
    wantSummary: opts.wantSummary,
    coarseTopics: opts.coarseTopics,
    examples: opts.examples,
    // P0-5: run-size budget line. Only the top-level call (depth 0) knows the
    // real run size; compensation re-sends omit it on purpose.
    totalCount: depth === 0 ? opts.totalInputs : undefined,
  });

  const { items, fatal, error } = await callTagWithRetryAndRepair(
    opts.config,
    prompt,
    group.length,
    opts.fetchImpl,
    opts.signal,
  );
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
  let modelTags = new Map<number, RawCandidate[]>();
  const summaries = new Map<number, string>();
  /** Bookmark index → topic phrase (model-supplied, used for clustering). */
  const topics = new Map<number, string>();
  /** Bookmark index → whether the model flagged the proposal as uncertain. */
  const needsReviewFlags = new Map<number, boolean>();
  /**
   * P0-6: per-bookmark cache writes collected DURING batching but flushed
   * only AFTER governance, so the cache never fixes ungoverned fragment tags
   * in place (a cached pre-governance result would bypass governance forever
   * on every later re-run of the same URL). Keyed by bookmark index so the
   * governed tag set can be joined back onto its URL key.
   */
  const pendingCacheWrites = new Map<number, { key: string; item: import('./prompt').ParsedItem }>();
  /** Last governance metrics, surfaced for tests and run stats. */
  let governance: GovernResult | null = null;
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
    // The partition signal is threaded through: when the partition budget is
    // nearly spent, fetching stops early and the model keeps what remains.
    const enriched = config.fetchContent
      ? await enrichInputsWithContent(inputs, options.fetchImpl, options.signal)
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
      // Root-cause fix (2026-08-30): when the partition budget is spent, every
      // remaining batch would die instantly on the aborted signal — and each
      // attempt still pays the retry backoff before failing. Break out instead
      // of burning the rest of the slice against a dead signal; those
      // bookmarks fall through to the per-bookmark fallback below.
      if (options.signal?.aborted) {
        modelError = modelError ?? '分区时间预算已用尽，本分片剩余书签未送入模型';
        break;
      }
      const slice = pending.slice(start, start + BATCH_SIZE);
      const sliceInputs = slice.map((p) => p.input);

      // 方案E: optional coarse pass. One cheap call per batch produces a topic
      // judgement that anchors the fine pass, improving tag granularity.
      let coarseTopics: Array<string | null> | undefined;
      if (config.twoPass) {
        const coarsePrompt = buildCoarsePrompt(sliceInputs);
        const outcome = await withRetry(
          () => callProvider(config, coarsePrompt, options.fetchImpl, options.signal),
          (o) => {
            if (o.ok) return 'ok';
            if (isFatal(o.error)) return 'stop';
            if (isTransientRetryable(o.error)) return 'retry';
            return 'stop';
          },
          {},
          options.signal,
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
          signal: options.signal,
          totalInputs: inputs.length,
        },
      );
      if (groupResult.error) {
        modelError = modelError ?? groupResult.error;
      }
      if (groupResult.fatal) {
        fatal = true;
        break;
      }

      for (const [localIdx, item] of groupResult.items) {
        const globalIndex = slice[localIdx].globalIndex;
        applyItem(globalIndex, item);
        // P0-6 write-back moved AFTER governance: only queue the entry here,
        // keyed by bookmark index so governed tags can be joined on later.
        // Empty results are NOT cached — a quiet model this time should not
        // poison the next run.
        if (cache && (item.tags.length > 0 || item.summary)) {
          pendingCacheWrites.set(globalIndex, { key: slice[localIdx].key, item });
        }
      }
    }

    // Silent-empty diagnosis (2026-08-30): the model answered every batch but
    // produced zero usable tags for the whole slice. Without this the run
    // degrades to domain fallback with NO error surfaced, which reads as
    // "the model works but only emits site names". Surface the reason instead.
    if (!modelContributed && !modelError && pending.length > 0) {
      modelError = '模型已响应但未产出任何可用标签（提示规则过严或模型拒绝生成），本次使用域名兜底';
    }

    // Tag-quality governance (PRD-TAG-QUALITY-2026-08-30): one deterministic,
    // model-free pass over the whole batch — global budget, minimum support
    // for brand-new names, merge/roll-up/drop rescue, never a zero-tag
    // bookmark. Runs BEFORE caching/synthesis so both see governed names.
    // Single-bookmark runs are exempt (PRD §7 Q6): minSupport=2 is unsolvable
    // at N=1, and the "pending promotion" design (P2-3) governs that path.
    if (modelContributed && inputs.length > 1) {
      governance = governTaxonomy(modelTags, vocab, inputs);
      modelTags = governance.tags;
      // Demoted tags (kept at reduced confidence for human review) flag their
      // bookmarks needsReview, so the review queue — not a threshold —
      // decides whether a demoted model tag survives.
      for (const [index, cands] of modelTags) {
        if (cands.some((c) => {
          const key = normalizeKey(c.name);
          return key ? governance!.demotedKeys.has(key) : false;
        })) {
          needsReviewFlags.set(index, true);
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

    // P0-6 (second half): flush the queued cache writes with the GOVERNED
    // tag set for each URL. Fallback-sourced rescue tags are excluded — they
    // are this batch's safety net, not the model's verdict on the URL. When
    // governance dropped everything model-sourced for a URL we SKIP the
    // write: caching the pre-governance fragment tags would re-poison the
    // very cache this change cleans up, and an empty entry only forces the
    // model to see the URL again next run — the correct outcome.
    if (cache && pendingCacheWrites.size > 0) {
      for (const [globalIndex, { key, item }] of pendingCacheWrites) {
        const governed = (modelTags.get(globalIndex) ?? []).filter(
          (c) => c.source !== 'fallback',
        );
        if (governed.length === 0 && item.tags.length > 0) continue;
        const modelTagsForUrl = governed.map((c) => ({
          name: c.name,
          confidence: c.confidence,
          reason: c.reason,
          isNew: !vocab.byKey.has(normalizeKey(c.name)),
        }));
        // Demotion (2026-08-30) keeps rescued tags at reduced confidence and
        // flags them for review — persist that flag, or a cache replay would
        // resurrect a demoted fragment as a fully-trusted suggestion.
        const cacheNeedsReview =
          item.needsReview ||
          needsReviewFlags.get(globalIndex) === true;
        await cache.put(key, {
          tags: modelTagsForUrl,
          summary: item.summary,
          topic: item.topic,
          needsReview: cacheNeedsReview,
        });
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

  return { results, engine, modelError, fatal, uncovered, suggestedTaxonomy, governance };
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
  /**
   * Optional abort signal bounding the per-partition model budget (set by `/run`
   * from `TN_PARTITION_BUDGET_MS`). Merged with `REQUEST_TIMEOUT_MS` inside the
   * provider so a slow model cannot push a partition past the Functions wall.
   */
  signal?: AbortSignal;
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
  signal?: AbortSignal,
): Promise<{ items: ParsedCategorizeItem[]; fatal: boolean; error: string | null }> {
  const result = await withRetry(
    () => callProvider(config, prompt, fetchImpl, signal),
    (outcome) => {
      if (outcome.ok) return 'ok';
      if (isFatal(outcome.error)) return 'stop';
      if (isTransientRetryable(outcome.error)) return 'retry';
      return 'stop';
    },
    {},
    signal,
  );

  if (!result.ok) {
    return { items: [], fatal: isFatal(result.error), error: result.error?.message ?? '模型调用失败' };
  }

  let items = parseCategorizeResponse(result.text, batchSize);
  if (items.length === 0) {
    const repairOutcome = await callProvider(
      config,
      `${prompt}\n\n注意：刚才的回复无法解析为 JSON 或返回了空分类。请严格只输出合法 JSON（不要 markdown 代码块、不要解释文字），以 { 或 [ 开头。`,
      fetchImpl,
      signal,
    );
    if (repairOutcome.ok && typeof repairOutcome.text === 'string') {
      const repaired = parseCategorizeResponse(repairOutcome.text, batchSize);
      if (repaired.length > 0) items = repaired;
    }
  }
  if (items.length === 0) {
    return {
      items: [],
      fatal: false,
      error: '模型返回了空分类（可能是提示规则过于严格或模型拒绝生成）',
    };
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
    signal?: AbortSignal;
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
    opts.signal,
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
 * Structured-organise upgrade: the model now reports a full `path` array of up
 * to three segments (root → leaf). Rules, each deliberate:
 *  - Every level passes the 4-pass `resolveTagName` normalisation, so spelling
 *    variants land on existing nodes instead of splitting the tree.
 *  - **Lift**: if the model named a nested node at any level (e.g. "前端开发"
 *    which lives under "开发技术"), the ancestor chain is prepended so the
 *    stored path matches what `parent_id` walking produces — never a shorter
 *    or different one.
 *  - **Parent-chain consistency**: each resolved level must be an existing
 *    child of the previously resolved level, or a brand-new node (flagged
 *    `isNew`, enters review). An existing node with a different parent is
 *    dropped together with everything after it, rather than silently
 *    re-homing it.
 *  - **New-node cut-off**: once a level had to be created, every following
 *    level must also be new — a deep existing node can never be claimed as
 *    the child of a node that does not exist yet.
 *  - Depth is capped at `MAX_CATEGORY_DEPTH` (3); deeper segments are dropped.
 *
 * Legacy two-field placements (`{category, subcategory}`) still flow through
 * here unchanged: they arrive as a two-segment path.
 */
export function normalizePlacement(
  parsed: Pick<ParsedCategory, 'path'> & Partial<Pick<ParsedCategory, 'category' | 'subcategory'>>,
  vocab: Vocabulary,
): { path: string[]; leafTagId: string | null; isNew: boolean; reuseFactor: number } | null {
  // Structured shape first; legacy cache entries (pre-2026-08-29) only carry
  // the flat two-field view, so derive a path from it rather than dropping
  // the placement.
  let segments = parsed.path;
  if ((!segments || segments.length === 0) && parsed.category) {
    segments = [parsed.category, ...(parsed.subcategory ? parsed.subcategory.split(' > ') : [])]
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!segments || segments.length === 0) return null;

  const byId = new Map(vocab.entries.map((e) => [e.id, e]));

  const path: string[] = [];
  let leafTagId: string | null = null;
  let isNew = false;
  let reuseFactor = 1;
  /** `undefined` before the first level; afterwards the id of the previous level. */
  let prevTagId: string | null | undefined = undefined;
  /** Set once a level had to be created; every later level must be new too. */
  let createdSoFar = false;

  for (const segment of segments) {
    if (path.length >= MAX_CATEGORY_DEPTH) break;
    const resolved = resolveTagName(segment, vocab);
    if (!resolved) continue;

    if (resolved.tagId) {
      const entry = byId.get(resolved.tagId);
      // Consistency: an existing node is only kept when its real parent is the
      // previously resolved level (or it is a root when nothing is resolved yet).
      const parentOk =
        prevTagId === undefined
          ? (entry?.parentId ?? null) === null
          : entry?.parentId === prevTagId;
      // Cut-off: after a created level, a deep existing node cannot follow.
      if (!createdSoFar && (parentOk || prevTagId === undefined)) {
        if (prevTagId === undefined && entry && entry.parentId) {
          // Lift: the model named a nested node as the top level — prepend its
          // real ancestor chain so the stored path matches `parent_id` walking.
          const ancestors: string[] = [];
          let cursor: VocabEntry | undefined = entry;
          while (cursor?.parentId && ancestors.length < MAX_CATEGORY_DEPTH - 1) {
            const parent = byId.get(cursor.parentId);
            if (!parent) break;
            ancestors.unshift(parent.name);
            cursor = parent;
          }
          path.push(...ancestors);
        }
        path.push(resolved.name);
        leafTagId = resolved.tagId;
        reuseFactor = Math.min(reuseFactor, resolved.confidenceFactor);
        prevTagId = resolved.tagId;
        continue;
      }
      // Parent mismatch (or post-creation claim) — drop this level and
      // everything after it rather than re-homing the subtree.
      break;
    }

    // A brand-new node under the previously resolved level — allowed, but
    // everything after it must be new as well.
    path.push(resolved.name);
    leafTagId = null;
    isNew = true;
    reuseFactor = Math.min(reuseFactor, resolved.confidenceFactor);
    prevTagId = null;
    createdSoFar = true;
  }

  if (path.length === 0) return null;
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
    // 方案A: 分类不再抓整页正文。书签自带的「标题 + 网址 + 描述」已足够决定它
    // 归入哪个网站/文件夹；抓取正文是单次整理耗时的最大来源，会把每个分片直接
    // 推过 Cloudflare Pages Functions 的 30s 墙钟上限。关掉抓取后单分片只剩一次
    // 模型调用，配合客户端并行分片即可把 168 条的总时长压到数十秒。
    const enriched = inputs;

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
      // Same abort-awareness as the tagging loop: a spent partition budget
      // must not burn the remaining batches (and their retry backoffs).
      if (options.signal?.aborted) {
        modelError = modelError ?? '分区时间预算已用尽，本分片剩余书签未送入模型';
        break;
      }
      const slice = pending.slice(start, start + BATCH_SIZE);
      const sliceInputs = slice.map((p) => p.input);

      const groupResult = await categorizeGroup(sliceInputs, sliceInputs.map((_, k) => k), 0, {
        config,
        vocab,
        examples: options.examples,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      });
      if (groupResult.error) {
        modelError = modelError ?? groupResult.error;
      }
      if (groupResult.fatal) {
        fatal = true;
        break;
      }

      for (const [localIdx, item] of groupResult.items) {
        const globalIndex = slice[localIdx].globalIndex;
        if (!item.category) continue; // row parsed but unusable → fallback path below
        const entry: CategoryCacheEntry = { ...item.category, source: 'model' as const };

        // Plan A (D2): force the site-level segment to the canonical label so the
        // same site always lands under the same L2/L3 across partitions, killing
        // the cross-partition duplicate-branch drift. We only override when the
        // model's segment normalises to the canonical site name, so unknown hosts
        // (whose canonical label is just the Title-cased domain) are never
        // wrongly rewritten and the change stays a no-op for non-site L2s.
        if (entry.path && entry.path.length >= 2) {
          const site = canonicalSiteLabel(slice[localIdx].input.url);
          const siteKey = normalizeKey(site);
          if (normalizeKey(entry.path[1]) === siteKey) {
            entry.path[1] = site;
          } else if (entry.path.length >= 3 && normalizeKey(entry.path[2]) === siteKey) {
            entry.path[2] = site;
          }
        }

        applyItem(globalIndex, entry);
        // Write-back: remember this URL's placement. Usability is guaranteed
        // by the fallback anyway, so caching a real placement is always safe.
        if (cache) await cache.put(slice[localIdx].key, entry);
      }
    }

    // Same silent-empty diagnosis as the tagging track: model answered but
    // produced no usable placement for the whole slice → say why instead of
    // silently degrading to the domain fallback.
    if (!modelContributed && !modelError && pending.length > 0) {
      modelError = '模型已响应但未产出任何可用分类（提示规则过严或模型拒绝生成），本次使用域名兜底';
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
        const rawPath = modelParsed.path.join(' > ');
        const renamed = renameByFeedback(rawPath, feedback);
        if (renamed !== rawPath) {
          const parts = renamed.split('>').map((p) => p.trim()).filter(Boolean);
          const rebuilt = makeParsedCategory(
            parts.length > 0 ? parts : modelParsed.path,
            modelParsed,
          );
          if (rebuilt) {
            working = {
              ...rebuilt,
              reason: `按你以往偏好改用「${renamed}」`,
            };
          }
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
        const normalized = normalizePlacement({ path: [fb.name] }, vocab);
        const path = normalized && normalized.path.length > 0 ? normalized.path : [fb.name];
        const parsedFb = makeParsedCategory([fb.name], {
          confidence: fb.confidence,
          reason: fb.reason,
          isNew: false,
          needsReview: true,
        });
        if (parsedFb) {
          const scored = scorePlacement(
            { ...parsedFb, source: 'fallback' as const },
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
        }
        if (candidate) uncovered += 1;
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

/* ------------------------------------------------------------------ *
 * Rename mode (structured-organise Phase B)
 *
 * Renaming mirrors `categorizeBookmarks` in robustness but is much
 * simpler: there is no tree to normalise against, no scoring, no
 * fallback engine. A rename suggestion only exists when the model
 * actually proposes a *different* title — the conservative prompt makes
 * `unchanged` a first-class outcome, and every `unchanged`/identical
 * row is dropped here so the review queue only holds real edits.
 * ------------------------------------------------------------------ */

/** A single rename proposal, ready for the review queue. */
export interface RenameCandidate {
  /** Current bookmark title. */
  original: string;
  /** Proposed cleaned title (guaranteed non-empty, ≠ original). */
  title: string;
  /** Short justification shown in the review UI. */
  reason: string;
}

export interface RenameResult {
  bookmarkId: string;
  /** Null when the title needs no change (model said unchanged or agreed). */
  rename: RenameCandidate | null;
}

export interface RenameOutcome {
  results: RenameResult[];
  engine: EngineKind;
  modelError: string | null;
  fatal: boolean;
  /** Bookmarks whose titles were already fine — surfaced in run stats. */
  unchanged: number;
}

export interface RenameOptions {
  /** Null when no model is available; without a model there is nothing to do. */
  config: AiConfig | null;
  fetchImpl?: typeof fetch;
  /**
   * Optional abort signal bounding the per-partition model budget (set by `/run`
   * from `TN_PARTITION_BUDGET_MS`). Merged with `REQUEST_TIMEOUT_MS` so a slow
   * model cannot push a partition past the Functions wall-clock.
   */
  signal?: AbortSignal;
  /**
   * Per-URL rename cache (`ai:rename:` namespace). Optional exactly like
   * the other caches: absent ⇒ always call the model.
   */
  renameCache?: RenameCache;
}

/**
 * Calls the model for one rename batch with the same retry + repair-turn
 * discipline as the other modes: transient failures retry, fatal errors
 * stop, and a response that parses to nothing earns one strict-JSON
 * repair turn before giving up.
 */
async function callRenameWithRetryAndRepair(
  config: AiConfig,
  prompt: string,
  batchSize: number,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ items: import('./prompt').ParsedRenameItem[]; fatal: boolean; error: string | null }> {
  const result = await withRetry(
    () => callProvider(config, prompt, fetchImpl, signal),
    (outcome) => {
      if (outcome.ok) return 'ok';
      if (isFatal(outcome.error)) return 'stop';
      if (isTransientRetryable(outcome.error)) return 'retry';
      return 'stop';
    },
    {},
    signal,
  );

  if (!result.ok) {
    return { items: [], fatal: isFatal(result.error), error: result.error?.message ?? '模型调用失败' };
  }

  let items = parseRenameResponse(result.text, batchSize);
  if (items.length === 0) {
    const repairOutcome = await callProvider(
      config,
      `${prompt}\n\n注意：刚才的回复无法解析为 JSON 或返回了空结果。请严格只输出合法 JSON（不要 markdown 代码块、不要解释文字），以 { 或 [ 开头。`,
      fetchImpl,
      signal,
    );
    if (repairOutcome.ok && typeof repairOutcome.text === 'string') {
      const repaired = parseRenameResponse(repairOutcome.text, batchSize);
      if (repaired.length > 0) items = repaired;
    }
  }
  if (items.length === 0) {
    return {
      items: [],
      fatal: false,
      error: '模型返回了空结果（可能是提示规则过于严格或模型拒绝生成）',
    };
  }
  return { items, fatal: false, error: null };
}

/**
 * Renames one group of bookmarks with the same precise-compensation policy as
 * the other modes: a partial response re-sends only the missing bookmarks (up
 * to COMPENSATE_DEPTH), so a truncated answer does not silently skip titles.
 */
async function renameGroup(
  group: BookmarkInput[],
  localIndices: number[],
  depth: number,
  opts: { config: AiConfig; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<{ items: Map<number, import('./prompt').ParsedRenameItem>; fatal: boolean; error: string | null }> {
  const out = new Map<number, import('./prompt').ParsedRenameItem>();
  if (group.length === 0) return { items: out, fatal: false, error: null };

  const prompt = buildRenamePrompt(group);
  const { items, fatal, error } = await callRenameWithRetryAndRepair(
    opts.config,
    prompt,
    group.length,
    opts.fetchImpl,
    opts.signal,
  );
  if (fatal) return { items: out, fatal: true, error };

  for (const item of items) {
    const li = localIndices[item.index];
    if (li !== undefined) out.set(li, item);
  }

  const missing = localIndices.filter((li) => !out.has(li));
  if (missing.length > 0 && missing.length < localIndices.length && depth < COMPENSATE_DEPTH) {
    const missingInputs = missing.map((li) => group[localIndices.indexOf(li)]);
    const sub = await renameGroup(missingInputs, missing, depth + 1, opts);
    if (sub.fatal) return { items: out, fatal: true, error: sub.error };
    for (const [li, item] of sub.items) out.set(li, item);
  }
  return { items: out, fatal: false, error: null };
}

/**
 * Produces a rename proposal for every input bookmark.
 *
 * Mirrors `categorizeBookmarks` in robustness: never throws; a failing model
 * degrades to "no suggestions" and reports why; a fatally misconfigured model
 * stops the job via `fatal`. Deterministic guards keep junk out of the queue:
 *  - `unchanged` rows become no-suggestion (the model approved the title);
 *  - rows whose proposed title equals the current one become no-suggestion;
 *  - cached entries are re-checked against the *current* title, so a title
 *    edited since the cache was written is never "renamed" back.
 */
export async function renameBookmarks(
  inputs: BookmarkInput[],
  options: RenameOptions,
): Promise<RenameOutcome> {
  if (inputs.length === 0) {
    return { results: [], engine: 'none', modelError: null, fatal: false, unchanged: 0 };
  }

  const { config } = options;

  const renames = new Map<number, RenameCacheEntry>();
  let modelContributed = false;
  let modelError: string | null = null;
  let fatal = false;

  // Renaming is content-first like the other modes: `autoTag` is the master
  // switch for AI organisation. Without a config there is nothing to propose.
  const wantModel = Boolean(config && config.autoTag);

  if (wantModel && config) {
    // Rename cares about title + URL + description; a full page fetch adds
    // latency without helping title cleanup, so enrichment is skipped here.
    const applyItem = (globalIndex: number, entry: RenameCacheEntry) => {
      modelContributed = true;
      renames.set(globalIndex, entry);
    };

    // Cache-first: URLs already cleaned under this prompt version + model skip
    // the model entirely. Lookups run in parallel — one round trip.
    const cache = options.renameCache;
    const pending: Array<{ input: BookmarkInput; globalIndex: number; key: string }> = [];
    if (cache) {
      const keys = await Promise.all(inputs.map((input) => renameCacheKeyFor(input.url, config.model)));
      const hits = await Promise.all(keys.map((key) => cache.get(key)));
      inputs.forEach((input, index) => {
        const hit = hits[index];
        if (hit) applyItem(index, hit);
        else pending.push({ input, globalIndex: index, key: keys[index] });
      });
    } else {
      inputs.forEach((input, index) => pending.push({ input, globalIndex: index, key: '' }));
    }

    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      // Same abort-awareness as the tagging loop: a spent partition budget
      // must not burn the remaining batches (and their retry backoffs).
      if (options.signal?.aborted) {
        modelError = modelError ?? '分区时间预算已用尽，本分片剩余书签未送入模型';
        break;
      }
      const slice = pending.slice(start, start + BATCH_SIZE);
      const sliceInputs = slice.map((p) => p.input);

      const groupResult = await renameGroup(sliceInputs, sliceInputs.map((_, k) => k), 0, {
        config,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      });
      if (groupResult.error) {
        modelError = modelError ?? groupResult.error;
      }
      if (groupResult.fatal) {
        fatal = true;
        break;
      }

      for (const [localIdx, item] of groupResult.items) {
        const globalIndex = slice[localIdx].globalIndex;
        if (!item.rename) continue;
        const entry: RenameCacheEntry = { ...item.rename };
        applyItem(globalIndex, entry);
        // Write-back: remember this URL's cleaned title. Cache even unchanged
        // verdicts — a "this title is fine" answer is worth remembering so a
        // re-run never re-bills the decision.
        if (cache) await cache.put(slice[localIdx].key, entry);
      }
    }
  } else if (!config) {
    modelError = '未配置可用的模型，跳过命名清理';
  }

  let unchanged = 0;
  const results: RenameResult[] = inputs.map((input, index) => {
    let candidate: RenameCandidate | null = null;

    const parsed = renames.get(index);
    if (parsed && !parsed.unchanged) {
      const title = parsed.title.trim();
      // Only a *different* non-empty title is a real suggestion.
      if (title && title !== input.title.trim()) {
        candidate = { original: input.title, title, reason: parsed.reason };
      }
    }
    if (!candidate) unchanged += 1;

    return { bookmarkId: input.id, rename: candidate };
  });

  let engine: EngineKind = 'none';
  if (modelContributed) engine = 'model';

  return { results, engine, modelError, fatal, unchanged };
}

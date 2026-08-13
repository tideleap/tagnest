import { domainFallbackTag } from './domain-fallback';
import { BATCH_SIZE, buildTaggingPrompt, parseTaggingResponse } from './prompt';
import { callProvider, isFatal, isRetryable } from './providers';
import { resolveCandidates } from './taxonomy';
import {
  sameHostBoost,
  scoreTagCandidate,
  vocabularyEntryFor,
} from './scoring';
import { renameByFeedback, type FeedbackProfile } from './feedback';
import type { AiConfig, EnrichInput, LocalConfig, RawCandidate, TagCandidate, Vocabulary } from './types';
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
}

export interface SuggestOptions {
  vocab: Vocabulary;
  /** Null when no model is available; the domain fallback still runs. */
  config: AiConfig | null;
  local: LocalConfig;
  feedback?: FeedbackProfile | null;
  fetchImpl?: typeof fetch;
}

/** One retry on a transient provider failure; more would stall a batch job. */
const MAX_ATTEMPTS = 2;

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

  const wantModel = Boolean(config && (config.autoTag || config.autoSummarize));

  if (wantModel && config) {
    for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
      const slice = inputs.slice(start, start + BATCH_SIZE);

      const prompt = buildTaggingPrompt(slice, vocab, {
        maxTags: local.maxTags,
        wantSummary: config.autoSummarize,
      });

      let text: string | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const outcome = await callProvider(config, prompt, options.fetchImpl);
        if (outcome.ok) {
          text = outcome.text;
          modelError = null;
          break;
        }
        modelError = outcome.error.message;
        if (isFatal(outcome.error)) {
          fatal = true;
          break;
        }
        if (!isRetryable(outcome.error) || attempt === MAX_ATTEMPTS) break;
      }

      if (fatal) break;
      if (!text) continue;

      for (const item of parseTaggingResponse(text, slice.length)) {
        const globalIndex = start + item.index;
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

  return { results, engine, modelError, fatal, uncovered };
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

import { heuristicCandidates, type RawCandidate } from './heuristics';
import { BATCH_SIZE, buildTaggingPrompt, parseTaggingResponse } from './prompt';
import { callProvider, isFatal, isRetryable } from './providers';
import { resolveCandidates } from './taxonomy';
import {
  sameHostBoost,
  scoreTagCandidate,
  vocabularyEntryFor,
} from './scoring';
import type { AiConfig, EnrichInput, LocalConfig, TagCandidate, Vocabulary } from './types';

/**
 * The orchestrator: turns bookmarks into reviewed-ready tag proposals.
 *
 * The pipeline is deliberately two-track rather than "call the model and hope":
 *
 *   heuristics ─┐
 *               ├─> resolveCandidates (normalise against the user's taxonomy,
 *   model      ─┘                      merge duplicates, reward agreement)
 *
 * Why both tracks matter:
 *
 *  - **Availability.** No key, dead provider, exhausted quota — the heuristic
 *    track still produces a usable result. The feature degrades instead of
 *    disappearing, which is the difference between "AI tagging" being a core
 *    capability and being a demo.
 *  - **Calibration.** Two independent engines reaching the same tag is
 *    meaningfully stronger evidence than one engine asserting it confidently.
 *    That consensus bonus is what makes an auto-apply threshold trustworthy.
 *  - **Grounding.** Local signals are passed into the prompt as hints, so the
 *    model starts from observable facts about the URL rather than from nothing.
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

export type EngineKind = 'model' | 'heuristic' | 'mixed' | 'none';

export interface SuggestOutcome {
  results: SuggestionResult[];
  /** Which engine actually produced the output — surfaced so a silent fallback is visible. */
  engine: EngineKind;
  /** Human-readable reason the model did not contribute, if it did not. */
  modelError: string | null;
  /** True when the caller should stop the whole job (bad key, missing model). */
  fatal: boolean;
}

export interface SuggestOptions {
  vocab: Vocabulary;
  /** Null when no model is available; heuristics still run. */
  config: AiConfig | null;
  local: LocalConfig;
  fetchImpl?: typeof fetch;
}

/** One retry on a transient provider failure; more would stall a batch job. */
const MAX_ATTEMPTS = 2;

/**
 * Produces suggestions for a set of bookmarks.
 *
 * Safe to call with anything from one bookmark to a few dozen; the model track
 * chunks internally at `BATCH_SIZE`. Never throws — a failing model degrades to
 * heuristics-only and reports why.
 */
export async function suggestForBookmarks(
  inputs: BookmarkInput[],
  options: SuggestOptions,
): Promise<SuggestOutcome> {
  if (inputs.length === 0) {
    return { results: [], engine: 'none', modelError: null, fatal: false };
  }

  const { vocab, config, local } = options;

  // ---- Track 1: local heuristics -------------------------------------
  const heuristics = new Map<number, RawCandidate[]>();
  if (local.heuristicsEnabled) {
    inputs.forEach((input, index) => {
      const candidates = heuristicCandidates(input);
      if (candidates.length > 0) heuristics.set(index, candidates);
    });
  }

  // ---- Track 2: the model --------------------------------------------
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

      const hints = new Map<number, RawCandidate[]>();
      slice.forEach((_, localIndex) => {
        const found = heuristics.get(start + localIndex);
        if (found) hints.set(localIndex, found.slice(0, 4));
      });

      const prompt = buildTaggingPrompt(slice, vocab, {
        maxTags: local.maxTags,
        wantSummary: config.autoSummarize,
        hints,
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
    modelError = '未配置可用的模型，本次使用本地规则整理';
  }

  // ---- Merge, normalise, rank, and score -----------------------------
  const results: SuggestionResult[] = inputs.map((input, index) => {
    const raw: RawCandidate[] = [
      ...(modelTags.get(index) ?? []),
      ...(heuristics.get(index) ?? []),
    ];

    // Base resolution: normalise against the user's taxonomy, merge duplicate
    // engines, and rank by agreement (as before).
    const resolved = raw.length > 0 ? resolveCandidates(raw, vocab, local.maxTags) : [];

    // Multi-dimensional scoring pass: for each candidate, fold in the user's
    // tag-usage frequency, the page's own lexical evidence, and the same-host
    // neighbourhood signal. Drop anything that falls below the confidence
    // floor — a pipeline that forces weak associations on the user is worse
    // than one that proposes fewer, better tags.
    const hostBoostCache = (name: string) => sameHostBoost(inputs, index, name);
    const scored: TagCandidate[] = [];
    for (const candidate of resolved) {
      const vocabEntry = vocabularyEntryFor(vocab, candidate.tagId, candidate.name);
      const boosted = scoreTagCandidate(
        candidate,
        input,
        hostBoostCache(candidate.name),
        vocabEntry,
      );
      if (boosted) scored.push(boosted);
    }
    scored.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

    // Prefer the model's own topic phrase; fall back to the top resolved tag
    // so the in-job topic distribution is still populated for heuristic-only
    // runs (e.g. no API key configured).
    const topic = topics.get(index) ?? (scored.length > 0 ? scored[0].name : null);
    const needsReview = needsReviewFlags.get(index) ?? false;

    return {
      bookmarkId: input.id,
      tags: scored.slice(0, Math.max(1, local.maxTags)),
      summary: summaries.get(index) ?? null,
      topic,
      needsReview,
    };
  });

  const usedHeuristics = local.heuristicsEnabled && heuristics.size > 0;
  let engine: EngineKind = 'none';
  if (modelContributed && usedHeuristics) engine = 'mixed';
  else if (modelContributed) engine = 'model';
  else if (usedHeuristics) engine = 'heuristic';

  return { results, engine, modelError, fatal };
}

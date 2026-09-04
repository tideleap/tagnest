/**
 * Tag-quality governance: a deterministic, model-free pass over the raw model
 * suggestions of one organize run.
 *
 * Why it exists: independent per-bookmark tagging fragments — hundreds of
 * one-bookmark tags ("孤立标签"), no global budget, no reuse pressure. This
 * module enforces three product rules AFTER all batches are back and BEFORE
 * anything is persisted or cached (PRD-TAG-QUALITY-2026-08-30):
 *
 *   R1 global budget      distinct NEW tag names ≤ distinctBudget(N);
 *                         existing vocabulary tags are always kept (P0-4)
 *   R2 minimum support    a brand-new tag must be used by ≥ minSupport
 *                         bookmarks in this batch, or it is rescued/dropped
 *   R3 singleton rescue   dropped assignments try merge → roll-up → drop,
 *                         and a bookmark is never left with zero tags
 *                         (domainFallbackTag is the last resort)
 *
 * Design deviations from the PRD, documented in
 * docs/ARCH-TAG-QUALITY-2026-08-30.md §3.1:
 *  - The budget caps NEW names only. The PRD's Top-D could cut a 20-count
 *    vocabulary tag the user relies on, which P0-4 forbids; existing tags
 *    always survive and new tags share what budget remains.
 *  - The 30% new-tag quota is inactive when the vocabulary is empty (cold
 *    start). The quota's purpose is to force reuse; with nothing to reuse it
 *    would only shred a first run into fallback noise — the exact failure the
 *    owner complained about. PRD §4.7 already exempts cold start elsewhere.
 *  - Merge matching adds prefix containment to edit-distance similarity, so
 *    "React Hooks" merges into "React" (P0-3①) which pure edit distance
 *    (0.5) would miss.
 *
 * Everything here is pure: same input, same output, no model calls, no clock,
 * no randomness. O(N·T + D²·len) with D ≤ distinctBudget ≤ 100, well under
 * the 200ms guard even at N=1000.
 */

import { domainFallbackTag } from './domain-fallback';
import { normalizeKey, similarity, buildVocabulary } from './taxonomy';
import type { EnrichInput, RawCandidate, VocabEntry, Vocabulary } from './types';

/** PRD-TAG-QUALITY §8 threshold table. Tuning = edit this block only. */
export const GOVERNANCE_DEFAULTS = {
  /** Absolute cap on distinct new tags per run (browse-ability limit). */
  distinctCap: 100,
  /** Floor so tiny runs are not over-coarsened. */
  distinctFloor: 6,
  /** Density: at most one distinct new tag per k bookmarks on average. */
  densityK: 3,
  /** A brand-new tag needs at least this many batch bookmarks. */
  minSupport: 2,
  /** New tags may occupy at most this share of the budget. */
  newTagRatio: 0.3,
  /** Edit-distance similarity above which a dropped name merges into a kept one. */
  mergeSimilarity: 0.75,
  /**
   * Tier-3 demotion floor: a not-kept new name whose average model confidence
   * reaches this is demoted (confidence ×0.6 + needsReview) instead of
   * dropped, so the model's verdict stays visible to the review queue.
   */
  demoteConfidenceFloor: 0.5,
} as const;

export type GovernanceConfig = typeof GOVERNANCE_DEFAULTS;

/** Global distinct-tag budget: D_max(N) = min(cap, max(floor, ceil(N/k))). */
export function distinctBudget(n: number, cfg: GovernanceConfig = GOVERNANCE_DEFAULTS): number {
  const nSafe = Math.max(0, Math.ceil(n));
  return Math.min(cfg.distinctCap, Math.max(cfg.distinctFloor, Math.ceil(nSafe / cfg.densityK)));
}

/** Post-governance quality card (P0-0 baseline + P1-7 persistence). */
export interface GovernanceQuality {
  /** Distinct tag names after governance (incl. fallback names). */
  distinct: number;
  /** Total tag assignments kept (deduped per bookmark). */
  assignments: number;
  /** Kept names that did not exist in the user's vocabulary. */
  newTags: number;
  /** Kept names whose effective support is exactly 1. */
  singletons: number;
  /** Ratio of kept assignments landing on existing vocabulary tags (0 when none). */
  reuseRate: number;
  /**
   * Distinct fallback names in the final result. Fallback tags exist to honour
   * the never-zero-tag guarantee and are bounded by distinct hosts, so the
   * budget applies to model names only: modelNames = distinct − fallbackNames.
   */
  fallbackNames: number;
  /**
   * Distinct names demoted this run (kept at reduced confidence, flagged for
   * review). They stay visible in the output by design, so the admitted-name
   * budget check is: distinct − fallbackNames − demotedNames ≤ budget.
   */
  demotedNames: number;
}

export interface GovernMetrics {
  /** The budget this run was governed against. */
  budget: number;
  merged: number;
  rolledUp: number;
  /** Assignments demoted instead of dropped (kept with needsReview). */
  demoted: number;
  /** Assignments fully dropped (below the demote confidence floor). */
  dropped: number;
}

export interface GovernResult {
  /** Governed per-bookmark candidates (governed name space, same order). */
  tags: Map<number, RawCandidate[]>;
  quality: GovernanceQuality;
  metrics: GovernMetrics;
  /**
   * Normalised keys demoted this run (kept at reduced confidence). The engine
   * uses this to flag the affected bookmarks needsReview so the review queue
   * — not a threshold — decides whether the tag survives.
   */
  demotedKeys: Set<string>;
}

interface TagStat {
  /** Canonical name for the stat (vocabulary spelling when it exists). */
  name: string;
  /** Bookmark count within this batch. */
  batchSupport: number;
  /** Vocabulary count when this name resolves onto an existing tag, else 0. */
  vocabCount: number;
  /** Sum of candidate confidences (ranking signal). */
  confSum: number;
  /** Number of contributing candidates — pairs with confSum for the average. */
  confCount: number;
  /** Whether the name already exists in the user's vocabulary. */
  existing: boolean;
  /** Indices of bookmarks proposing this name (each index once). A Set so the
   *  per-candidate membership test is O(1) — the old array `.includes` made the
   *  whole pass O(N²·T) at large batch sizes (A-5, round-2 audit). */
  holders: Set<number>;
}

/**
 * Resolves a name against the vocabulary the same way the pipeline later will
 * (exact → alias), so governance never disagrees with `resolveCandidates`
 * about what counts as "existing". The fuzzy neighbour pass is deliberately
 * NOT applied here — a fuzzy hit still creates a merge candidate downstream,
 * and treating near-misses as existing would hide them from the budget.
 */
function vocabEntryForName(name: string, vocab: Vocabulary): VocabEntry | null {
  const key = normalizeKey(name);
  if (!key) return null;
  return vocab.byKey.get(key) ?? null;
}

/**
 * Merge-worthiness of a dropped name against a kept name: edit-distance
 * similarity at the configured threshold, or prefix containment for keys of
 * a sensible minimum length (ASCII 3+, CJK 2+). Containment is what makes
 * "React Hooks" → "React" work; edit distance alone scores that pair 0.5.
 *
 * `keptKey` is the pre-normalised kept key (computed once per kept name, not
 * per dropped×kept pair — that is the difference between ~5ms and ~200ms at
 * N=1000). A cheap length guard runs before the O(len²) edit distance: to
 * reach `threshold` similarity the edit distance must be ≤ (1−threshold)×
 * longest, so keys whose lengths differ by more than that can never merge.
 */
function mergeScore(key: string, keptKey: string, threshold: number): number {
  if (!key || !keptKey || key === keptKey) return 0;

  // Prefix containment first — cheap and covers the common sub-concept case.
  const shorter = key.length <= keptKey.length ? key : keptKey;
  const longer = shorter === key ? keptKey : key;
  const isAscii = /^[\x20-\x7E]+$/.test(shorter);
  const minLen = isAscii ? 3 : 2;
  if (shorter.length >= minLen && longer.startsWith(shorter)) return threshold;

  // Length guard: similarity ≥ threshold is impossible when the length gap
  // already exceeds the allowed edit distance.
  const longest = Math.max(key.length, keptKey.length);
  if (Math.abs(key.length - keptKey.length) > (1 - threshold) * longest) return 0;

  const sim = similarity(key, keptKey);
  return sim >= threshold ? sim : 0;
}

/**
 * Governance pass over the raw suggestions of one run.
 *
 * Operates on the ORIGINAL model name space (before rename/resolve), so the
 * per-bookmark candidate objects may be rewritten (merged/rolled-up names)
 * but their confidence/source are preserved. Never returns an empty list for
 * a bookmark that had tags — the drop path re-seeds via `domainFallbackTag`.
 */
export function governTaxonomy(
  modelTags: Map<number, RawCandidate[]>,
  vocab: Vocabulary,
  inputs: ReadonlyArray<EnrichInput>,
  cfg: GovernanceConfig = GOVERNANCE_DEFAULTS,
): GovernResult {
  const metrics: GovernMetrics = { budget: 0, merged: 0, rolledUp: 0, demoted: 0, dropped: 0 };

  // ---- 1. Collect tag statistics across the whole batch ----------------
  const stats = new Map<string, TagStat>();
  /** Raw candidate key → stat key (vocabulary spellings collapse variants). */
  const rawToStat = new Map<string, string>();
  for (const [index, cands] of modelTags) {
    for (const cand of cands) {
      const rawKey = normalizeKey(cand.name);
      if (!rawKey) continue;
      const entry = vocabEntryForName(cand.name, vocab);
      const name = entry ? entry.name : cand.name;
      const statKey = normalizeKey(name) || rawKey;
      let stat = stats.get(statKey);
      if (!stat) {
        stat = {
          name,
          batchSupport: 0,
          vocabCount: entry?.count ?? 0,
          confSum: 0,
          confCount: 0,
          existing: Boolean(entry),
          holders: new Set<number>(),
        };
        stats.set(statKey, stat);
      }
      if (!rawToStat.has(rawKey)) rawToStat.set(rawKey, statKey);
      // One bookmark counts once per tag even if the model repeated it.
      if (!stat.holders.has(index)) {
        stat.batchSupport += 1;
        stat.holders.add(index);
      }
      stat.confSum += cand.confidence;
      stat.confCount += 1;
    }
  }

  if (stats.size === 0) {
    return {
      tags: modelTags,
      quality: {
        distinct: 0,
        assignments: 0,
        newTags: 0,
        singletons: 0,
        reuseRate: 0,
        fallbackNames: 0,
        demotedNames: 0,
      },
      metrics,
      demotedKeys: new Set<string>(),
    };
  }

  const n = Math.max(inputs.length, modelTags.size);
  const budget = distinctBudget(n, cfg);
  metrics.budget = budget;

  // ---- 2. Admission: existing tags always; new tags by rank ------------
  // New tags rank by support ×2 + confidence (support outweighs a single
  // high-confidence claim); ties break by name for determinism.
  const rankedNew = [...stats.entries()]
    .filter(([, s]) => !s.existing)
    .sort((a, b) => {
      const sa = a[1].batchSupport * 2 + a[1].confSum;
      const sb = b[1].batchSupport * 2 + b[1].confSum;
      if (sb !== sa) return sb - sa;
      return a[1].name.localeCompare(b[1].name);
    });

  const keptKeys = new Set<string>();
  for (const [statKey, stat] of stats) {
    if (stat.existing) keptKeys.add(statKey);
  }

  // New-tag admission: fill whatever budget remains after existing tags,
  // subject to minSupport and — unless the vocabulary is empty (cold start)
  // — the 30% new-tag quota.
  const newSlots = Math.max(0, budget - keptKeys.size);
  const quotaActive = vocab.entries.length > 0;
  const newQuota = quotaActive ? Math.floor(budget * cfg.newTagRatio) : Number.POSITIVE_INFINITY;
  let newKept = 0;
  for (const [statKey, stat] of rankedNew) {
    if (newKept >= Math.min(newSlots, newQuota)) break;
    if (stat.batchSupport < cfg.minSupport) continue;
    keptKeys.add(statKey);
    newKept += 1;
  }

  // ---- 3. Rescue paths for names that did not make the keep-set --------
  // Pre-normalise kept names ONCE (not per dropped×kept pair) — this is the
  // difference between ~5ms and ~200ms at N=1000.
  const keptPairs = [...keptKeys]
    .map((k) => {
      const name = stats.get(k)!.name;
      return { name, key: normalizeKey(name) || name };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const droppedStats = [...stats.entries()].filter(([statKey]) => !keptKeys.has(statKey));

  /**
   * statKey →
   *  - string  : merge/roll-up replacement name
   *  - 'demote': keep the model's own tag but downgrade it (confidence ×
   *              DEMOTE_CONFIDENCE_FACTOR, flagged needsReview) so it lands
   *              in the review queue instead of being deleted
   *  - null    : drop entirely (reserved for unmergeable non-CJK noise)
   */
  const rewrite = new Map<string, string | 'demote' | null>();

  /**
   * Root-cause fix (2026-08-30 "全走域名兜底"): the old tier-3 dropped every
   * under-supported new name outright. In production, runs are sliced into
   * 20-bookmark partitions and governance runs per slice, so a diverse
   * slice's model tags mostly have slice-support 1 → tier 3 deleted nearly
   * every model proposal → bookmarks re-seeded with domain fallbacks, which
   * are themselves singletons. The model was effectively vetoed. Demotion
   * keeps the model's verdict visible, marks it for human confirmation, and
   * lets the review queue — not a threshold — decide what survives. Full
   * drops now happen only when merge and roll-up both miss AND the name is
   * not worth showing a human (see `demotable` below).
   */
  const DEMOTE_CONFIDENCE_FACTOR = 0.6;

  for (const [statKey, stat] of droppedStats) {
    let resolved: string | 'demote' | null = null;
    let action: 'merged' | 'rolledUp' | 'demoted' | null = null;

    // ① Merge into the most similar kept name.
    let best: { name: string; score: number } | null = null;
    for (const kept of keptPairs) {
      const score = mergeScore(statKey, kept.key, cfg.mergeSimilarity);
      if (score > 0 && (!best || score > best.score)) best = { name: kept.name, score };
    }
    if (best) {
      resolved = best.name;
      action = 'merged';
    }

    // ② Roll up to the vocabulary parent of an existing-but-unkept entry.
    //    (Unreachable today — existing tags are always kept — kept as a
    //    guard for future admission rules that may cut existing names.)
    if (!resolved && stat.existing) {
      const entry = vocabEntryForName(stat.name, vocab);
      const parent = entry?.parentId
        ? vocab.entries.find((e: VocabEntry) => e.id === entry.parentId)?.name ?? null
        : null;
      if (parent && keptKeys.has(normalizeKey(parent) || parent)) {
        resolved = parent;
        action = 'rolledUp';
      }
    }

    // ③ Demote: keep the model's tag, downgrade confidence, flag review.
    //    Only names the model proposed with some conviction are worth a
    //    human glance; ultra-low-confidence noise is dropped as before.
    if (!resolved) {
      const avgConf = stat.batchSupport > 0 ? stat.confSum / stat.confCount : 0;
      if (avgConf >= cfg.demoteConfidenceFloor) {
        resolved = 'demote';
        action = 'demoted';
      }
    }

    rewrite.set(statKey, resolved);
    const affected = stat.holders.size;
    if (action === 'merged') metrics.merged += affected;
    else if (action === 'rolledUp') metrics.rolledUp += affected;
    else if (action === 'demoted') metrics.demoted += affected;
    else metrics.dropped += affected;
  }

  // ---- 4. Apply rewrites, then guarantee non-empty tag lists -----------
  const out = new Map<number, RawCandidate[]>();
  /** Names demoted this run — engine flags their holders for review. */
  const demotedKeys = new Set<string>();
  for (const [index, cands] of modelTags) {
    const next: RawCandidate[] = [];
    for (const cand of cands) {
      const rawKey = normalizeKey(cand.name);
      if (!rawKey) continue;
      const statKey = rawToStat.get(rawKey) ?? rawKey;
      const rule = rewrite.get(statKey);
      if (rule === null) continue; // hard drop (below the demote floor)
      // Note: demote/merge targets are BY DESIGN not in keptKeys — they were
      // rescued after failing admission. Only null means "drop"; anything
      // else rewrites or demotes in place. (The former `!keptKeys.has(...)`
      // guard made both rescue paths unreachable and re-seeded every
      // affected bookmark with a domain fallback — the 2026-08-30 bug.)
      const stat = stats.get(statKey);
      if (!stat) continue; // defensive; unreachable
      if (rule === 'demote') {
        // Keep the model's own tag but make the human the gatekeeper.
        demotedKeys.add(statKey);
        next.push({
          ...cand,
          confidence: Math.max(0, Math.min(1, cand.confidence * DEMOTE_CONFIDENCE_FACTOR)),
          reason: `${cand.reason} · 支持度不足已降级，请人工确认`,
        });
        continue;
      }
      const name = rule ?? stat.name;
      next.push(
        rule
          ? { ...cand, name, reason: `${cand.reason} · 并入「${name}」（相似标签治理）` }
          : { ...cand, name },
      );
    }

    // Non-empty guarantee: a bookmark whose every assignment was dropped
    // gets exactly one domain-derived fallback (never zero-tag).
    if (next.length === 0 && cands.length > 0) {
      const fb = domainFallbackTag(inputs[index]);
      if (fb) next.push(fb);
    }
    if (next.length > 0) out.set(index, next);
  }

  // ---- 5. Quality metrics ----------------------------------------------
  const finalSupport = new Map<string, number>();
  /** Fallback-sourced names — exempt from the model-name budget accounting. */
  const fallbackNames = new Set<string>();
  let assignments = 0;
  for (const cands of out.values()) {
    const seen = new Set<string>();
    for (const cand of cands) {
      const key = normalizeKey(cand.name) || cand.name;
      if (seen.has(key)) continue;
      seen.add(key);
      finalSupport.set(key, (finalSupport.get(key) ?? 0) + 1);
      if (cand.source === 'fallback') fallbackNames.add(key);
    }
    assignments += seen.size;
  }
  let newTagNames = 0;
  let newAssign = 0;
  let singletonNames = 0;
  for (const [statKey, stat] of stats) {
    if (!keptKeys.has(statKey)) continue;
    const support = finalSupport.get(statKey) ?? 0;
    const effective = Math.max(support, stat.vocabCount, stat.existing ? 1 : 0);
    if (effective <= 1) singletonNames += 1;
    if (!stat.existing) {
      newTagNames += 1;
      newAssign += support;
    }
  }
  const reuseRate = assignments > 0 ? (assignments - newAssign) / assignments : 0;

  const quality: GovernanceQuality = {
    distinct: finalSupport.size,
    assignments,
    newTags: newTagNames,
    singletons: singletonNames,
    reuseRate: Math.round(reuseRate * 100) / 100,
    fallbackNames: fallbackNames.size,
    demotedNames: demotedKeys.size,
  };

  return { tags: out, quality, metrics, demotedKeys };
}

/**
 * Convenience wrapper for callers that start from raw vocabulary entries.
 */
export function governRawTags(
  modelTags: Map<number, RawCandidate[]>,
  vocabEntries: VocabEntry[],
  inputs: ReadonlyArray<EnrichInput>,
  cfg: GovernanceConfig = GOVERNANCE_DEFAULTS,
): GovernResult {
  return governTaxonomy(modelTags, buildVocabulary(vocabEntries), inputs, cfg);
}

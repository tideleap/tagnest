import type { AiProvider } from '../../../shared/types';

/**
 * Shared vocabulary for the AI tagging pipeline.
 *
 * Kept in its own module so the pure algorithm files (taxonomy, heuristics,
 * prompt) can be imported by tests without dragging in a database type or a
 * Cloudflare binding.
 */

export interface AiConfig {
  provider: AiProvider;
  baseUrl: string | null;
  model: string;
  apiKey: string;
  autoTag: boolean;
  autoSummarize: boolean;
  /** Suggestions at or above this confidence skip human review. 1 = review all. */
  autoApplyThreshold: number;
  /** Per-bookmark ceiling on suggested tags. */
  maxTags: number;
}

/**
 * Config for a run where no provider is reachable.
 *
 * The heuristic engine still needs limits and a threshold, so "no model" is
 * represented as a real config rather than a null that every caller has to
 * special-case. This is what makes the feature work with no API key.
 */
export interface LocalConfig {
  autoApplyThreshold: number;
  maxTags: number;
}

export interface EnrichInput {
  url: string;
  title: string;
  description?: string | null;
}

/** Which engine produced a candidate. Surfaced in the UI and used for scoring. */
export type CandidateSource = 'model' | 'fallback' | 'taxonomy';

/** A pre-normalisation tag proposal produced by an engine (model or fallback). */
export interface RawCandidate {
  name: string;
  confidence: number;
  source: CandidateSource;
  reason: string;
}

/**
 * One proposed tag, with everything the review UI needs to justify it.
 *
 * `confidence` and `reason` are not decoration: a suggestion a user cannot
 * evaluate at a glance is a suggestion they will reject wholesale, which is
 * how "AI tagging" features end up switched off.
 */
export interface TagCandidate {
  /** Final name, already normalised against the user's existing taxonomy. */
  name: string;
  /** Existing tag this resolved to; null means accepting creates a new tag. */
  tagId: string | null;
  /** 0..1. */
  confidence: number;
  source: CandidateSource;
  /** Short human-readable justification, e.g. "域名 github.com" or "复用已有标签". */
  reason: string;
  /**
   * Set when the user's feedback history lifted this candidate's confidence.
   * Surfaced in the review queue as a "已学习" hint and persisted alongside the
   * suggestion so the loop is visible.
   */
  feedbackBoosted?: boolean;
}

export interface Enrichment {
  summary: string | null;
  tags: TagCandidate[];
  /** Topic phrase for the bookmark, used for clustering. */
  topic: string | null;
  /** Model's own recommendation for human review. */
  needsReview: boolean;
}

/** A tag as the normaliser sees it. */
export interface VocabEntry {
  id: string;
  name: string;
  /** Alternative spellings folded into this tag. */
  aliases: string[];
  /** How many bookmarks carry it — the tie-breaker when two tags match. */
  count: number;
}

/** The user's existing tag system, indexed for fast normalisation. */
export interface Vocabulary {
  entries: VocabEntry[];
  /** normalised key -> entry. Covers names and aliases. */
  byKey: Map<string, VocabEntry>;
}

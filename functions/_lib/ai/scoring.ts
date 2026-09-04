import type { EnrichInput, TagCandidate, VocabEntry, Vocabulary } from './types';
import { normalizeKey } from './taxonomy';
import { hostOf } from '../urlkey';
import { feedbackMultiplier, type FeedbackProfile } from './feedback';

/**
 * Multi-dimensional scoring signals that raise the precision of the AI
 * tagging pipeline. Each function is pure and synchronous so the behaviour is
 * unit-testable without a database or network.
 *
 * The motivating problem: with a plain "domain rule + model guess" pipeline, a
 * large library ends up with few AI-generated labels because the signals that
 * make a suggestion trustworthy (the user's own habits, the shape of the page
 * being tagged) were never fed into the confidence number. These signals turn
 * three otherwise-inert facts into score boosts:
 *
 *   1. Tag usage frequency  — a tag the user reaches for often is a safer bet
 *                             than one they have never used.
 *   2. Lexical agreement    — when a model's tag name literally appears in the
 *                             bookmark's own title/description, that is direct
 *                             evidence, not a guess.
 *   3. Confidence floor     — suggestions below a floor are dropped outright,
 *                             so a pipeline never forces weak associations
 *                             into the user's taxonomy.
 */

/**
 * Maps a tag's bookmark count to a confidence multiplier, saturating so a
 * hugely popular tag does not dwarf everything.
 *
 *   count 0 → 1.00   (unknown tag: neutral)
 *   count 1 → 1.02
 *   count 3 → 1.07
 *   count 8 → 1.14
 *   count 20 → 1.22
 *   count >=~50 → 1.28 (cap)
 *
 * The shape is `1 + K * (1 - 1/(1 + a*count))`: steep early (one or two uses
 * already signal a real habit), then flat. Pass a tag's `count` from the
 * vocabulary when one exists, otherwise 0.
 */
export const MAX_FREQUENCY_FACTOR = 1.28;
const FREQ_K = 0.28;
const FREQ_A = 0.12;

export function tagFrequencyFactor(count: number): number {
  const c = Math.max(0, Number(count) || 0);
  return Math.min(MAX_FREQUENCY_FACTOR, 1 + FREQ_K * (1 - 1 / (1 + FREQ_A * c)));
}

/**
 * Confidence floor below which a suggestion is dropped rather than surfaced.
 *
 * The UI already gates auto-apply via `autoApplyThreshold`; this is a harder,
 * earlier gate so a weak association is never even *offered* for review. The
 * two thresholds are different jobs: this one prevents noise, the UI threshold
 * decides whether an accepted-but-uncertain suggestion skips the human step.
 */
export const MIN_MODEL_CONFIDENCE = 0.35;
/** Domain-derived fallback proposals must clear a slightly higher bar. */
export const MIN_FALLBACK_CONFIDENCE = 0.4;

/**
 * Lexical agreement bonus.
 *
 * When a candidate tag's name (or its key) appears in the bookmark's own
 * title/description, that is first-party evidence the model is not hallucinating
 * a topic. We add a fixed bonus rather than multiplying so a weak candidate
 * can still be lifted past the floor when the page itself mentions the word.
 */
export const LEXICAL_BONUS = 0.12;

/** Extracts every case-insensitive ASCII word and standalone CJK run from text. */
export function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  // ASCII words.
  const ascii = lower.match(/[a-z][a-z0-9+'-]*/g) ?? [];
  for (const w of ascii) if (w.length >= 2) out.add(w);
  // CJK runs — used as single tokens since there are no delimiters.
  const cjk = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) out.add(run);
  return out;
}

/**
 * How much a tag name overlaps the bookmark's observable text.
 *
 * Returns a 0..1 score: exact containment of the tag in the title/description
 * scores high; weaker is a partial token overlap. `null` when there is no
 * meaningful lexical relation (no overlap).
 *
 * B-10: bare substring containment is only safe for CJK names (the script has
 * no word boundaries, so containment *is* the match) and for multi-word
 * phrases (specific enough that accidental substring hits are rare). A single
 * ASCII word must match on whole tokens instead — otherwise "ai" scores full
 * evidence inside "email" and "go" inside "google", systematically inflating
 * short-tag confidence past the auto-apply threshold.
 */
export function lexicalEvidence(input: EnrichInput, tagName: string): number | null {
  const haystack = `${input.title ?? ''} ${input.description ?? ''}`.toLowerCase();
  if (!haystack.trim()) return null;

  const name = tagName.toLowerCase().trim();
  if (!name) return null;

  const hasCjk = /[\u4e00-\u9fff]/.test(name);
  const isMultiWord = /\s/.test(name);

  // Direct containment is the strongest, simplest signal ("python" in "Python
  // 教程: ...") — but only for CJK names and multi-word phrases. Single ASCII
  // words fall through to the token-boundary check below.
  if (name.length >= 2 && (hasCjk || isMultiWord) && haystack.includes(name)) return 1;

  // ASCII / token-level: any whole-token overlap is meaningful. For a
  // single-word ASCII tag this is an exact word-boundary match (full score on
  // a whole-token hit, no score on a mere substring hit).
  const nameTokens = tokensOf(name);
  if (nameTokens.size === 0) return null;
  const hayTokens = tokensOf(haystack);
  let overlap = 0;
  for (const t of nameTokens) if (hayTokens.has(t)) overlap += 1;
  if (overlap === 0) return null;
  return Math.min(1, overlap / Math.max(1, nameTokens.size));
}

/**
 * Same-host accent: boosts a candidate when several bookmarks in the current
 * batch come from the same site and would plausibly share this tag.
 *
 * This is the "同源站点" signal — pages from one host tend to be one topic, so a
 * tag that the host's other bookmarks textually overlap with is more likely
 * correct. Because exactly the bookmarks being analysed are in hand, this is
 * computed per batch without a DB round-trip. `tagId`/`vocab` are accepted for
 * future extension but the working proxy here is lexical overlap with peers.
 */
export function sameHostBoost(
  inputs: Array<EnrichInput & { id: string }>,
  index: number,
  tagName: string,
): number {
  // Only meaningful when there is more than one bookmark from the same host.
  const thisHost = hostOf(inputs[index].url);
  if (!thisHost) return 1;

  let peers = 0;
  let agreeing = 0;
  for (let i = 0; i < inputs.length; i += 1) {
    if (i === index) continue;
    const otherHost = hostOf(inputs[i].url);
    if (otherHost !== thisHost) continue;
    peers += 1;
    // How often do same-host peers' own text overlap with this tag name?
    if (lexicalEvidence(inputs[i], tagName) != null) agreeing += 1;
  }

  if (peers === 0) return 1;
  // Up to +0.15 as more same-host peers agree.
  return 1 + 0.15 * Math.min(1, agreeing / Math.max(1, peers));
}

/**
 * Applies the lexical + frequency + host signals to a resolved candidate and
 * returns whether it clears the confidence floor.
 *
 * `vocabEntry` is the user's tag corresponding to `tagId` when the candidate
 * reuses an existing tag (its `count` feeds the frequency factor), else null.
 */
export function scoreTagCandidate(
  candidate: TagCandidate,
  input: EnrichInput,
  hostBoost: number,
  vocabEntry: VocabEntry | null,
  /** User feedback memory; when present, bends confidence by (tag, domain) history. */
  feedback?: FeedbackProfile | null,
): TagCandidate | null {
  let confidence = candidate.confidence;

  // 1) Frequency: reuse of a tag the user already works with is stronger.
  if (vocabEntry) confidence *= tagFrequencyFactor(vocabEntry.count);

  // 2) Lexical evidence from the page itself.
  const lex = lexicalEvidence(input, candidate.name);
  if (lex != null && lex > 0) confidence += LEXICAL_BONUS * lex;

  // 3) Same-host neighbourhood.
  confidence *= hostBoost;

  // 4) User feedback memory: bend confidence by the (tag, domain) history.
  //    A strongly-rejected tag is dropped outright; a strongly-accepted tag is
  //    lifted; a mixed history is chipped down but never below the mixed floor.
  let feedbackBoosted = false;
  if (feedback) {
    const domain = hostOf(input.url);
    const tagEffect = feedbackMultiplier(feedback.byTag.get(normalizeKey(candidate.name)));
    if (tagEffect.drop) return null;
    let mult = tagEffect.mult;
    if (domain) {
      const tdEffect = feedbackMultiplier(
        feedback.byTagDomain.get(`${normalizeKey(candidate.name)}|${domain}`),
      );
      if (tdEffect.drop) return null;
      if (tdEffect.mult > mult) mult = tdEffect.mult;
    }
    if (mult !== 1) {
      confidence = Math.min(1, Math.max(0, confidence * mult));
      if (mult > 1) feedbackBoosted = true;
    }
  }

  const capped = Math.min(1, Math.max(0, confidence));
  const floor =
    candidate.source === 'fallback' ? MIN_FALLBACK_CONFIDENCE : MIN_MODEL_CONFIDENCE;

  if (capped < floor) return null;

  return { ...candidate, confidence: capped, feedbackBoosted };
}

/** Highest-frequency existing tag for a candidate, for the reuse boost. */
export function vocabularyEntryFor(vocab: Vocabulary, tagId: string | null, name: string): VocabEntry | null {
  if (tagId) {
    // A-5（第二轮审计）: O(1) id lookup via the prebuilt index instead of a
    // linear `entries.find` per candidate on the hot scoring path.
    const hit = vocab.byId.get(tagId);
    if (hit) return hit;
  }
  const key = normalizeKey(name);
  return vocab.byName.get(key) ?? null;
}

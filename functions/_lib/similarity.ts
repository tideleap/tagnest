/**
 * Bookmark similarity scoring for the "相似书签" (related bookmarks) feature.
 *
 * Deliberately heuristic, not semantic: the product is single-user, offline-
 * first, and zero-knowledge for private bookmarks, so pulling in an embedding
 * model would add an external dependency and break the privacy boundary. Three
 * weighted signals give a stable 0..1 score that is fully deterministic (same
 * input → same output), which keeps the contract tests meaningful.
 *
 * All functions here are pure so they can be unit-tested without a database.
 */
import type { Bookmark } from '../../shared/types';

/** Fields needed to score one side of a bookmark pair. */
export interface SimilarFields {
  tagIds: string[];
  url: string;
  title: string;
  description: string | null;
  note: string | null;
}

const TAG_WEIGHT = 0.6;
const DOMAIN_WEIGHT = 0.25;
const TEXT_WEIGHT = 0.15;

/** Normalises any URL or `url_key` down to its bare host (scheme/path stripped). */
export function hostOf(input: string): string {
  if (!input) return '';
  let s = input.trim().toLowerCase();
  const proto = s.indexOf('://');
  if (proto >= 0) s = s.slice(proto + 3);
  // Host is everything before the first path/query/fragment separator.
  const cut = Math.min(
    ...['/', '?', '#'].map((c) => (s.includes(c) ? s.indexOf(c) : Infinity)),
  );
  if (Number.isFinite(cut) && cut >= 0) s = s.slice(0, cut);
  if (s.startsWith('www.')) s = s.slice(4);
  return s;
}

/**
 * Splits text into a flat token multiset: each CJK character becomes its own
 * token (Chinese has no word boundaries), while Latin/digit runs become words.
 * Lowercased; punctuation dropped. Empty input → empty array.
 */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const out: string[] = [];
  const re = /[一-鿿]|[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) out.push(m[0]);
  return out;
}

/** Dice coefficient over two token multisets: 2·|A∩B| / (|A|+|B|). Empty → 0. */
export function diceCoefficient(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of b) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      overlap += 1;
      counts.set(t, c - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
}

/** Jaccard over two id sets: |A∩B| / |A∪B|. Empty → 0. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Combines the three signals into a single 0..1 score. */
export function scoreBookmarkSimilarity(source: SimilarFields, cand: SimilarFields): number {
  const tagJ = jaccard(source.tagIds, cand.tagIds);
  const host = hostOf(source.url);
  const sameDomain = host !== '' && host === hostOf(cand.url) ? 1 : 0;
  const textDice = diceCoefficient(
    tokenize(`${source.title} ${source.description ?? ''} ${source.note ?? ''}`),
    tokenize(`${cand.title} ${cand.description ?? ''} ${cand.note ?? ''}`),
  );
  const score = TAG_WEIGHT * tagJ + DOMAIN_WEIGHT * sameDomain + TEXT_WEIGHT * textDice;
  return Math.max(0, Math.min(1, score));
}

/** Convenience adapter from a full `Bookmark` to `SimilarFields`. */
export function bookmarkToSimilarFields(b: Bookmark): SimilarFields {
  return {
    tagIds: b.tags.map((t) => t.id),
    url: b.url,
    title: b.title,
    description: b.description,
    note: b.note,
  };
}

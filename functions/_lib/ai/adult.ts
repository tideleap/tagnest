// functions/_lib/ai/adult.ts
//
// Conservative adult-content quarantine (2026-08-30).
//
// Why this exists: a single adult bookmark inside a batch can make a
// safety-aligned model REFUSE the whole batch — it answers with a refusal
// message (or empty tags) instead of JSON, the parser yields nothing, and the
// entire slice silently degrades to domain fallback. The fix is to quarantine
// obviously-adult bookmarks BEFORE they reach the model: they never enter the
// prompt, they get one deterministic neutral tag, and they wait in the review
// queue like every other low-trust suggestion.
//
// Design rules (deliberately conservative — 宁漏勿错):
//  - Only well-known adult domains (exact or sub-domain match) and explicit
//    title keywords trigger quarantine. Ambiguous signals (e.g. "sex" inside
//    "essex") must NOT match.
//  - A false negative is acceptable: the prompt's safety framework (see
//    prompt.ts) tells the model to neutral-tag borderline content instead of
//    refusing the batch, so a missed site cannot take the whole run down.
//  - A false positive is merely a bookmark routed to the 「成人内容」 review
//    queue, where the user can re-tag it — visible and reversible.

import type { EnrichInput } from './types';

/** The single neutral tag quarantined bookmarks are filed under. */
export const ADULT_TAG_NAME = '成人内容';

/**
 * Confidence stamped on a quarantined placement. Deliberately neutral: the
 * heuristic is sure enough to file the bookmark, but the row is ALWAYS flagged
 * `needsReview` (and auto-apply respects that flag), so this number is cosmetic
 * rather than a gate. 0.5 matches the domain-fallback convention.
 */
export const ADULT_QUARANTINE_CONFIDENCE = 0.5;

/**
 * Registrable domains (and their sub-domains) quarantined without a model
 * round trip. Kept tiny and uncontroversial — this is a safety valve, not a
 * content classifier.
 */
const ADULT_HOSTS = new Set([
  'pornhub.com',
  'xvideos.com',
  'xnxx.com',
  'youporn.com',
  'redtube.com',
  'tube8.com',
  'xhamster.com',
  'spankbang.com',
  'hqporner.com',
  'eporner.com',
  'beeg.com',
  'txxx.com',
  'chaturbate.com',
  'bongacams.com',
  'livejasmin.com',
  'onlyfans.com',
  'hentai.name',
  'nhentai.net',
  'e-hentai.org',
  'exhentai.org',
  'rule34.xxx',
  'javhd.com',
  'missav.com',
  'javtiful.com',
]);

/**
 * Explicit adult markers in a bookmark title. Word-boundary ASCII terms plus
 * unambiguous CJK terms. Deliberately narrow: "sex" must not match "essex" or
 * "Middlesex", so ASCII terms use \b boundaries.
 */
const ADULT_TITLE_PATTERN =
  /\b(porn|porno|pornhub|hentai|nsfw|onlyfans|chaturbate|webcam\s*sex|adult\s*video|xxx)\b|成人|色情|黄片|AV女优|无码|福利姬|约炮/i;

/** Extracts the hostname, lower-cased and www-stripped; null when unparseable. */
function hostOfUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

/**
 * True when a bookmark is obviously adult content and must be quarantined
 * away from the model. Conservative on purpose: misses are covered by the
 * prompt's safety framework; false hits only land in the review queue.
 */
export function looksAdult(input: EnrichInput): boolean {
  const host = hostOfUrl(input.url);
  if (host) {
    if (ADULT_HOSTS.has(host)) return true;
    for (const domain of ADULT_HOSTS) {
      if (host.endsWith(`.${domain}`)) return true;
    }
  }
  const title = input.title ?? '';
  if (title && ADULT_TITLE_PATTERN.test(title)) return true;
  return false;
}

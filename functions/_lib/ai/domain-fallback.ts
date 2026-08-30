// functions/_lib/ai/domain-fallback.ts
//
// Last-resort domain → tag fallback used when the model contributes nothing.
// The brand mapping and helpers themselves now live in `shared/siteLabel.ts`
// (the single source of truth shared with the browser export path); this module
// re-exports `KNOWN_BRANDS` / `brandFromHost` for backwards compatibility and
// keeps the `domainFallbackTag` envelope that `engine.ts` consumes.

import type { CandidateSource, EnrichInput, RawCandidate } from './types';
import { hostOf } from '../urlkey';
import { KNOWN_BRANDS, brandFromHost } from '@shared/siteLabel';

export { KNOWN_BRANDS, brandFromHost };

/**
 * Derives a single fallback tag from the bookmark's host so that every bookmark
 * still receives at least one tag even when the model contributes nothing.
 *
 * The tag is marked `source: 'fallback'` and the caller is expected to set
 * `needsReview` so the user can confirm or replace it. This is a coverage
 * safety net, not a tagging strategy: it exists only so "no model output" never
 * means "no tag at all" (see docs/AI-HIERARCHY.md).
 */
export function domainFallbackTag(input: EnrichInput): RawCandidate | null {
  const host = hostOf(input.url);
  const name = host ? (KNOWN_BRANDS[host] ?? brandFromHost(host)) : '未分类';
  return {
    name,
    confidence: 0.5,
    source: 'fallback' as CandidateSource,
    reason: `域名派生兜底（${host ?? input.url}）`,
  };
}

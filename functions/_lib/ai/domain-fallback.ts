// functions/_lib/ai/domain-fallback.ts
//
// Last-resort domain → tag fallback used when the model contributes nothing.
// The brand mapping and helpers themselves now live in `shared/siteLabel.ts`
// (the single source of truth shared with the browser export path); this module
// re-exports `KNOWN_BRANDS` / `brandFromHost` for backwards compatibility and
// keeps the `domainFallbackTag` envelope that `engine.ts` consumes.

import type { CandidateSource, EnrichInput, RawCandidate } from './types';
import { hostOf } from '../urlkey';
import { KNOWN_BRANDS, brandFromHost, canonicalSiteLabel } from '../../../shared/siteLabel';

export { KNOWN_BRANDS, brandFromHost };

/**
 * Derives a single fallback tag from the bookmark's host so that every bookmark
 * still receives at least one tag even when the model contributes nothing.
 *
 * The tag is marked `source: 'fallback'` and the caller is expected to set
 * `needsReview` so the user can confirm or replace it. This is a coverage
 * safety net, not a tagging strategy: it exists only so "no model output" never
 * means "no tag at all" (see docs/AI-HIERARCHY.md).
 *
 * D-1（第二轮审计）: 直接复用 `canonicalSiteLabel(input.url)`，与分类轨道的
 * 规范站点名同一口径。此前 `KNOWN_BRANDS[host]` 只做精确匹配，`gist.github.com`
 * 兜底得「Github」（brandFromHost 首字母大写），分类轨道却规范为「GitHub」，
 * 品牌碎片化；现两条轨道输出完全一致（子域后缀匹配 + 公共后缀感知）。
 */
export function domainFallbackTag(input: EnrichInput): RawCandidate | null {
  const host = hostOf(input.url);
  const label = canonicalSiteLabel(input.url);
  const name = label && label !== '未命名站点' ? label : '未分类';
  return {
    name,
    confidence: 0.5,
    source: 'fallback' as CandidateSource,
    reason: `域名派生兜底（${host ?? input.url}）`,
  };
}

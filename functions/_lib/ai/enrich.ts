import type { EnrichInput } from './types';

/**
 * Page-content enrichment (design doc 方案A).
 *
 * The single biggest accuracy lever for AI tagging: the model used to see only
 * a title, a URL and an optional description — so clickbait titles, generic
 * titles ("首页", "Untitled") and description-less pages forced it to guess.
 * This module fetches each bookmark's page and distils a short text excerpt
 * (title + meta + opening body text) that rides along into the prompt.
 *
 * ## Failure policy: enrichment is optional, never blocking
 *
 * A large share of the web refuses to be fetched (paywalls, bot walls,
 * timeouts, non-HTML responses). Every failure path returns `null` and the
 * pipeline proceeds with title/URL/description exactly as before. Enrichment
 * must only ever *add* signal — it can never turn a working organise run into
 * a failing one, and it can never stall it: each fetch has a hard timeout and
 * the batch runs with bounded concurrency.
 *
 * ## Why a regex extractor instead of HTMLRewriter
 *
 * HTMLRewriter is the robust Workers-native choice, but the backend test suite
 * runs in plain Node where it does not exist, and the requirement here is only
 * "a short, representative text excerpt" — not DOM fidelity. A small,
 * dependency-free extractor keeps the logic unit-testable in both environments
 * and is good enough for classification input.
 */

/** Per-fetch deadline. Short on purpose: a slow page is not worth waiting for. */
const FETCH_TIMEOUT_MS = 6_000;

/**
 * Whole-batch enrichment budget, independent of the per-partition model
 * budget (TN_PARTITION_BUDGET_MS, default 22s).
 *
 * Root-cause fix (2026-08-30 "全走域名兜底"): enrichment used to run at full
 * concurrency with no awareness of the partition signal — worst case 4 waves
 * × 6s = 24s of fetching, which drained the 22s partition budget BEFORE the
 * first model call. Every model call then died instantly on the aborted
 * signal and the whole slice degraded to domain fallbacks. The budget now
 * caps fetching at a fraction of the typical partition budget and the workers
 * stop early when either runs out, so the model always gets its share of the
 * wall-clock.
 */
const ENRICH_BUDGET_MS = 8_000;

/** Read at most this many bytes of the body — the excerpt needs only the head. */
const MAX_BODY_BYTES = 300_000;

/** How many pages to fetch at once. Bounded so a 20-bookmark chunk does not open 20 sockets. */
const CONCURRENCY = 6;

/** Excerpt length fed into the prompt (characters). */
const EXCERPT_CHARS = 500;

export interface PageExcerpt {
  /** Visible opening text of the page, whitespace-collapsed. */
  text: string;
  /** Meta/og description when present. */
  metaDescription: string | null;
  /** og:title or the <title> element when present. */
  pageTitle: string | null;
}

/** True for URLs worth fetching — anything else (chrome://, file://, …) is skipped. */
export function isFetchable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    });
}

/** Pulls the content of a <meta> tag by name or property, case-insensitively. */
function metaContent(html: string, key: string): string | null {
  // Match the meta tag in either attribute order.
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]*content=["'][^"']*["'][^>]*(?:name|property)=["']${key}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const content = match[0].match(/content=["']([^"']*)["']/i);
    if (content && content[1].trim()) return decodeEntities(content[1].trim());
  }
  return null;
}

/**
 * Distils an HTML document into a short excerpt.
 *
 * Pure and synchronous so it is trivially unit-testable. Never throws: any
 * malformed input yields an empty result rather than an exception.
 */
export function extractExcerptFromHtml(html: string): PageExcerpt | null {
  if (!html || typeof html !== 'string') return null;

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;

  const metaDescription =
    metaContent(html, 'og:description') ?? metaContent(html, 'description');

  // Strip everything that is not readable content before collecting text.
  let body = html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');

  // Prefer the main content area when the page marks one up explicitly and it
  // carries real substance (a stub <article> is not worth switching to).
  const mainMatch = body.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  if (mainMatch && mainMatch[1].replace(/<[^>]+>/g, '').trim().length > 40) {
    body = mainMatch[1];
  }

  const text = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXCERPT_CHARS);

  if (!text && !metaDescription && !pageTitle) return null;
  return { text, metaDescription, pageTitle };
}

/**
 * Fetches one page and extracts its excerpt.
 *
 * Returns null on any failure — network error, timeout, non-2xx, non-HTML
 * content, empty body. The caller treats null as "no enrichment available".
 */
export async function fetchPageExcerpt(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PageExcerpt | null> {
  if (!isFetchable(url)) return null;

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Identify honestly; many default UA strings are blocked outright.
        'user-agent': 'TagNest-Organizer/1.0 (+https://tagnest.pages.dev)',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return null;

    // Read only the head of the document — the excerpt never needs the whole page.
    const buffer = await response.arrayBuffer();
    const html = new TextDecoder().decode(buffer.slice(0, MAX_BODY_BYTES));
    return extractExcerptFromHtml(html);
  } catch {
    return null;
  }
}

/**
 * Renders an excerpt as the prompt-facing content line.
 *
 * Meta description first when it adds information beyond the excerpt text:
 * editors write it to summarise the page, so it is usually the densest signal
 * per token. Kept short — the prompt budget belongs to the taxonomy.
 */
export function renderExcerpt(excerpt: PageExcerpt): string | null {
  const parts: string[] = [];
  if (excerpt.metaDescription && !excerpt.text.startsWith(excerpt.metaDescription)) {
    parts.push(excerpt.metaDescription.slice(0, 200));
  }
  if (excerpt.text) parts.push(excerpt.text);
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined ? joined.slice(0, EXCERPT_CHARS) : null;
}

/**
 * Enriches a batch of inputs with page excerpts, bounded concurrency.
 *
 * Returns a new array in input order; each input gains `pageExcerpt` when a
 * fetch succeeded. Inputs that are not fetchable keep their shape untouched.
 * Never throws.
 *
 * Two hard stop conditions protect the model's share of the partition
 * budget:
 *  - `ENRICH_BUDGET_MS` — the whole batch's fetch phase is capped, so a run
 *    of slow/withholding sites cannot starve the model call that follows;
 *  - `signal` — when the partition budget is nearly spent, fetching stops
 *    immediately and whatever excerpts have landed are returned as-is.
 * Under either condition un-fetched inputs simply stay un-enriched (title/
 * URL/description only), which is the documented non-blocking contract.
 */
export async function enrichInputsWithContent<T extends EnrichInput>(
  inputs: T[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<T[]> {
  if (inputs.length === 0) return [];

  const results: Array<PageExcerpt | null> = new Array(inputs.length).fill(null);
  let cursor = 0;
  const startedAt = Date.now();
  const timeLeft = () =>
    Date.now() - startedAt < ENRICH_BUDGET_MS && !(signal?.aborted ?? false);

  async function worker(): Promise<void> {
    while (timeLeft() && cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fetchPageExcerpt(inputs[index].url, fetchImpl);
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, inputs.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return inputs.map((input, index) => {
    const excerpt = results[index];
    const rendered = excerpt ? renderExcerpt(excerpt) : null;
    return rendered ? { ...input, pageExcerpt: rendered } : input;
  });
}

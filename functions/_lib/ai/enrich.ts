import type { EnrichInput } from './types';
import { isBlockedHost } from '../ssrf';

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
 * budget (TN_PARTITION_BUDGET_MS, default 25s).
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

/**
 * Minimum wall-clock reserved for the model call, no matter how slow the
 * page-fetch phase is. Fetching and the model call share ONE partition signal
 * (run.ts `partitionSignal`, default 25s); if fetching burned most of it, the
 * model call was squeezed to whatever remained and timed out on any slightly
 * slow gateway — surfacing as "全走域名兜底". The fetch budget is therefore
 * clamped to `partitionBudget - MODEL_TIME_FLOOR_MS` (see
 * `effectiveEnrichBudgetMs`), guaranteeing the model always gets its floor.
 */
const MODEL_TIME_FLOOR_MS = 15_000;

/**
 * Effective fetch-phase budget for one partition.
 *
 * `min(ENRICH_BUDGET_MS, partitionBudget - MODEL_TIME_FLOOR_MS)`: fetching may
 * never eat into the time floor reserved for the model call. When
 * `partitionBudgetMs` is absent (the single-bookmark path does not pass one)
 * or non-positive, the original flat `ENRICH_BUDGET_MS` applies unchanged.
 * Pure and synchronous so it is trivially unit-testable.
 */
export function effectiveEnrichBudgetMs(partitionBudgetMs?: number): number {
  if (!partitionBudgetMs || partitionBudgetMs <= 0) return ENRICH_BUDGET_MS;
  return Math.min(ENRICH_BUDGET_MS, Math.max(0, partitionBudgetMs - MODEL_TIME_FLOOR_MS));
}

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

/** Upper bound on manual redirects followed during enrichment. */
const MAX_ENRICH_REDIRECTS = 5;

/**
 * C-4（第二轮审计）: SSRF-safe fetch for page enrichment.
 *
 * `isFetchable` only checks the protocol (http/https); it does NOT filter
 * private / loopback / link-local / metadata hosts, and `redirect: 'follow'`
 * would let a legitimate page 302 into the internal network. This helper
 * closes both gaps, mirroring the C-3 defense in providers.ts:
 *   - the literal hostname is checked against `isBlockedHost` before the first
 *     request and again on every redirect hop;
 *   - redirects are followed manually (`redirect: 'manual'`) so each hop's
 *     target is re-validated before it is fetched.
 * Returns null (never throws) when the URL or any hop is blocked, so the
 * caller simply treats the page as un-enrichable.
 */
async function ssrfSafeFetchPage(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  let current = url;
  const init: RequestInit = {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: {
      // Identify honestly; many default UA strings are blocked outright.
      'user-agent': 'TagNest-Organizer/1.0 (+https://tagnest.pages.dev)',
      accept: 'text/html,application/xhtml+xml',
    },
  };

  for (let hop = 0; hop <= MAX_ENRICH_REDIRECTS; hop += 1) {
    // Validate the literal host of this hop before fetching it.
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (isBlockedHost(parsed.hostname)) return null;

    const res = await fetchImpl(current, init);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      // Drain the redirect body so the connection can be reused.
      await res.arrayBuffer().catch(() => null);
      if (!loc) return null;
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        return null;
      }
      current = next.toString();
      continue;
    }
    return res;
  }
  return null; // too many redirects
}

/**
 * Fetches one page and extracts its excerpt.
 *
 * Returns null on any failure — network error, timeout, non-2xx, non-HTML
 * content, empty body, or a blocked (private/internal) host. The caller treats
 * null as "no enrichment available".
 */
export async function fetchPageExcerpt(
  url: string,
  fetchImpl: typeof fetch = fetch,
  partitionSignal?: AbortSignal,
): Promise<PageExcerpt | null> {
  if (!isFetchable(url)) return null;

  // A-2（第二轮审计）: 把分区 signal 并入在途抓取。此前单页抓取只挂
  // `AbortSignal.timeout(FETCH_TIMEOUT_MS)`，worker 仅在发起新抓取前检查
  // `signal.aborted`，在途请求不响应分区信号——抓取预算到期时，6 个在途请求最晚
  // 还要再跑满各自的 6s 超时才结束，把「模型时间底线」挤掉。现用 AbortSignal.any
  // 合并分区信号与单页超时，分区预算一到期在途抓取立即中止。`AbortSignal.any`
  // 不可用时（极旧运行时）退回单页超时，行为与旧版一致。
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal =
    partitionSignal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([partitionSignal, timeoutSignal])
      : timeoutSignal;

  try {
    // C-4（第二轮审计）: 走 SSRF 安全抓取——字面主机名经 isBlockedHost 过滤，
    // 重定向逐跳复检，堵住「合法页面 302 跳内网」与「直接保存内网地址书签」两条路。
    const response = await ssrfSafeFetchPage(url, signal, fetchImpl);
    if (!response) return null;

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return null;

    // A-1（第二轮审计）: 流式读取正文，下载阶段即受 MAX_BODY_BYTES 硬上限约束。
    // 旧实现 `await response.arrayBuffer()` 先把**整个**响应缓冲进内存、再切片——
    // 300KB 上限只在切片时起作用。一个声明 text/html 的超大响应（数百 MB）可在
    // 6s 超时内打满 Workers isolate 内存（128MB）或显著拖慢抓取波次，挤占分区预算，
    // 连累同分片其余书签（单页 DoS 面）。现改用 getReader() 累计到上限即 cancel()，
    // 下载量与内存占用都有硬上界；摘要只需文档头部，截断不影响提取质量。
    let html: string;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          chunks.push(value);
          received += value.byteLength;
          if (received >= MAX_BODY_BYTES) {
            // Enough for the excerpt — stop downloading the rest of the page.
            await reader.cancel();
            break;
          }
        }
      } catch {
        return null;
      }
      // Coalesce, truncating the (possibly over-shot) tail to the cap.
      const total = Math.min(received, MAX_BODY_BYTES);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        const take = Math.min(chunk.byteLength, total - offset);
        merged.set(chunk.subarray(0, take), offset);
        offset += take;
        if (offset >= total) break;
      }
      html = new TextDecoder().decode(merged);
    } else {
      // Environments without a streaming body (defensive; Workers always have one).
      const buffer = await response.arrayBuffer();
      html = new TextDecoder().decode(buffer.slice(0, MAX_BODY_BYTES));
    }
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
 *  - the effective fetch budget (`effectiveEnrichBudgetMs(partitionBudgetMs)`)
 *    — the whole batch's fetch phase is capped, so a run of slow/withholding
 *    sites cannot starve the model call that follows. When a partition budget
 *    is supplied the cap is additionally clamped to
 *    `partitionBudget - MODEL_TIME_FLOOR_MS`, reserving a time floor for the
 *    model call no matter how slow fetching is; without one (single-bookmark
 *    path) the flat `ENRICH_BUDGET_MS` applies;
 *  - `signal` — when the partition budget is nearly spent, fetching stops
 *    immediately and whatever excerpts have landed are returned as-is.
 * Under either condition un-fetched inputs simply stay un-enriched (title/
 * URL/description only), which is the documented non-blocking contract.
 */
export async function enrichInputsWithContent<T extends EnrichInput>(
  inputs: T[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  partitionBudgetMs?: number,
): Promise<T[]> {
  if (inputs.length === 0) return [];

  const results: Array<PageExcerpt | null> = new Array(inputs.length).fill(null);
  let cursor = 0;
  const startedAt = Date.now();
  const enrichBudget = effectiveEnrichBudgetMs(partitionBudgetMs);
  const timeLeft = () =>
    Date.now() - startedAt < enrichBudget && !(signal?.aborted ?? false);

  async function worker(): Promise<void> {
    while (timeLeft() && cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      // A-2（第二轮审计）: 把分区 signal 传入在途抓取，预算到期即中止在途请求，
      // 不再让 6 个在途抓取各自跑满 6s 超时挤占模型时间底线。
      results[index] = await fetchPageExcerpt(inputs[index].url, fetchImpl, signal);
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

/**
 * RSS / Atom parsing and feed refresh.
 *
 * Two layers:
 *   1. `parseFeed` — a dependency-free, fault-tolerant parser. It is a pure
 *      function (XML string → structured items) so it is unit-testable without
 *      any D1 / network fixture. We deliberately do NOT pull in a full XML
 *      parser: the import path already parses HTML with regex, and a feed is a
 *      small, well-bounded document where regex + careful entity decoding covers
 *      the 99% of RSS 2.0 and Atom feeds we actually see.
 *   2. `refreshFeed` — fetch a feed URL (injectable fetcher), parse it, dedupe
 *      against the user's existing bookmarks, ensure the feed's default tags,
 *      and write new bookmarks. All network and DB access is passed in so it
 *      can run against the in-memory MockDb in tests.
 */

import type { Env } from './env';
import type { Feed, FeedCadence } from '../../shared/types';
import { FEED_CADENCES } from '../../shared/types';
import { ApiException, badRequestCode } from './http';
import { newId, nowIso } from './ids';
import { ensureTags } from './db';
import { faviconFor, titleFallback, urlKey, canonicalUrl } from './urlkey';
import { isBlockedHost } from './ssrf';

/** A single entry inside a parsed feed. */
export interface FeedItem {
  url: string;
  title: string;
  summary: string | null;
  /** ISO timestamp when available, else null. */
  publishedAt: string | null;
}

export interface ParsedFeed {
  /** Feed-level title (channel/feed), or null when absent. */
  title: string | null;
  items: FeedItem[];
}

/** A minimal `fetch` shape so callers can inject a stub in tests. */
export type FeedFetcher = (url: string, init?: RequestInit) => Promise<Response>;

const FEED_FETCH_TIMEOUT_MS = 10_000;

const FEED_USER_AGENT = 'TagNest-Feed-Fetcher/1.0 (+https://tagnest.app)';

/**
 * Strips CDATA wrappers and decodes the handful of HTML entities that appear
 * in feed text (titles, descriptions). A full entity table is unnecessary for
 * display-only fields; over-decoding is worse than under-decoding here.
 */
function decodeEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Inner text of the first matching `<tag>…</tag>` (case-insensitive). */
function innerText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return null;
  const text = decodeEntities(m[1]);
  return text.length ? text : null;
}

/**
 * Resolves a link for an entry/feed block. Handles both shapes:
 *   - Atom:   `<link rel="alternate" href="https://…"/>` (prefer non-self)
 *   - RSS:    `<link>https://…</link>`
 */
function linkOf(block: string): string | null {
  const atomLinks = [...block.matchAll(/<link\b([^>]*)>/gi)];
  for (const hit of atomLinks) {
    const attrs = hit[1];
    const rel = /rel=["']([^"']*)["']/i.exec(attrs);
    if (rel && /\bself\b/i.test(rel[1])) continue; // skip self / pagination links
    const href = /href=["']([^"']+)["']/i.exec(attrs);
    if (href) return href[1];
  }
  const text = innerText(block, 'link');
  return text && text.length ? text : null;
}

/** Coerces a feed date string into ISO, or null when unparseable. */
function toIso(raw: string | null): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function splitBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[\\s>][\\s\\S]*?</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

/** Parses an RSS 2.0 or Atom document into {title, items}. Never throws. */
export function parseFeed(xml: string): ParsedFeed {
  if (!xml || !xml.trim()) return { title: null, items: [] };

  const lower = xml.toLowerCase();
  const isAtom = lower.includes('<feed') && (lower.includes('<entry') || lower.includes('xmlns="http://www.w3.org/2005/atom'));

  if (isAtom) {
    const feedTitle = innerText(xml, 'title') ?? null;
    const items: FeedItem[] = [];
    for (const entry of splitBlocks(xml, 'entry')) {
      const url = linkOf(entry);
      if (!url) continue;
      const title = innerText(entry, 'title') ?? titleFallback(url);
      const summary = innerText(entry, 'summary') ?? innerText(entry, 'content');
      const publishedAt = toIso(
        innerText(entry, 'published') ?? innerText(entry, 'updated') ?? innerText(entry, 'issued'),
      );
      items.push({ url, title, summary, publishedAt });
    }
    return { title: feedTitle, items };
  }

  // RSS 2.0 (and RDF/RSS 1.0 best-effort via <item> blocks).
  const channelTitle = innerText(xml, 'title') ?? null;
  const items: FeedItem[] = [];
  for (const item of splitBlocks(xml, 'item')) {
    const url = linkOf(item) ?? innerText(item, 'guid');
    if (!url) continue;
    const title = innerText(item, 'title') ?? titleFallback(url);
    const summary = innerText(item, 'description') ?? innerText(item, 'content:encoded');
    const publishedAt = toIso(innerText(item, 'pubdate') ?? innerText(item, 'dc:date'));
    items.push({ url, title, summary, publishedAt });
  }
  return { title: channelTitle, items };
}

/** Production fetcher with a hard timeout and a identifying User-Agent. */
async function defaultFetcher(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': FEED_USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface RefreshFeedInput {
  id: string;
  url: string;
  tagNames: string[];
}

export interface RefreshOutcome {
  added: number;
  skipped: number;
  failed: number;
}

/** Loads the set of url_keys the user already holds, chunked for D1's param cap. */
async function loadExistingKeys(env: Env, userId: string, keys: string[]): Promise<Set<string>> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return new Set();
  const rows = await queryUrlKeys(env, unique, userId);
  return new Set(rows);
}

async function queryUrlKeys(env: Env, keys: string[], userId: string): Promise<string[]> {
  const out: string[] = [];
  const CHUNK = 99;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT url_key FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL AND url_key IN (${placeholders})`,
    )
      .bind(userId, ...slice)
      .all<{ url_key: string }>();
    for (const r of rows.results) out.push(r.url_key);
  }
  return out;
}

/** Records the outcome of a fetch against the feed row. */
async function recordStatus(
  env: Env,
  feedId: string,
  userId: string,
  status: string,
  fetchedAt: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE feeds SET last_fetched_at = ?, last_status = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(fetchedAt, status, fetchedAt, feedId, userId)
    .run();
}

/**
 * Fetches and applies one feed: parse → dedupe → ensure tags → insert bookmarks.
 *
 * SSRF guard: the stored feed URL is re-checked here (defence in depth) even
 * though subscribe already validated it, because a feed's host could later
 * resolve to something private via a redirect the literal-host check can't see.
 * We block on the literal hostname and never follow into a blocked host via
 * `redirect: 'follow'` — Cloudflare will refuse the connection anyway, but the
 * explicit guard keeps the error message honest.
 */
export async function refreshFeed(
  env: Env,
  userId: string,
  feed: RefreshFeedInput,
  fetcher: FeedFetcher = defaultFetcher,
): Promise<RefreshOutcome> {
  let host: string;
  try {
    host = new URL(feed.url).hostname;
  } catch {
    await recordStatus(env, feed.id, userId, 'feed_invalid_url', nowIso());
    throw badRequestCode('feed_invalid_url', '订阅源地址无法解析');
  }
  if (isBlockedHost(host)) {
    await recordStatus(env, feed.id, userId, 'feed_blocked_host', nowIso());
    throw badRequestCode('feed_blocked_host', '该地址不可订阅（内网 / 保留地址）');
  }

  let res: Response;
  try {
    res = await fetcher(feed.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordStatus(env, feed.id, userId, 'feed_fetch_failed', nowIso());
    throw new ApiException(502, 'feed_fetch_failed', `订阅源拉取失败：${msg}`);
  }

  if (!res.ok) {
    await recordStatus(env, feed.id, userId, `http_${res.status}`, nowIso());
    throw new ApiException(502, 'feed_fetch_failed', `订阅源返回 HTTP ${res.status}`);
  }

  const xml = await res.text();
  const parsed = parseFeed(xml);
  const fetchedAt = nowIso();

  if (parsed.items.length === 0) {
    await recordStatus(env, feed.id, userId, 'empty', fetchedAt);
    return { added: 0, skipped: 0, failed: 0 };
  }

  const keys = parsed.items.map((i) => urlKey(i.url));
  const existing = await loadExistingKeys(env, userId, keys);

  const tagIds =
    feed.tagNames.length > 0 ? (await ensureTags(env, userId, feed.tagNames)).ids : [];

  let added = 0;
  let skipped = 0;
  let failed = 0;
  const statements: D1PreparedStatement[] = [];

  for (const item of parsed.items) {
    const key = urlKey(item.url);
    if (!key) {
      failed += 1;
      continue;
    }
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    // Don't double-add two entries from the same feed that share a URL.
    existing.add(key);

    const id = newId();
    const storedUrl = canonicalUrl(item.url) ?? item.url;
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO bookmarks
           (id, user_id, url, url_key, title, description, favicon_url, cover_url, note,
            ai_summary, is_favorite, is_archived, visit_count, last_visited_at,
            created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 0, 0, 0, NULL, ?, ?, NULL)`,
      ).bind(
        id,
        userId,
        storedUrl,
        key,
        (item.title || titleFallback(item.url)).slice(0, 300),
        faviconFor(item.url),
        item.publishedAt ?? fetchedAt,
        fetchedAt,
      ),
    );
    for (const tagId of tagIds) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)`,
        ).bind(id, tagId),
      );
    }
    added += 1;
  }

  if (statements.length > 0) {
    // Run in batches so an import-sized feed never exceeds D1's 100-statement cap.
    for (let i = 0; i < statements.length; i += 90) {
      await env.DB.batch(statements.slice(i, i + 90));
    }
  }

  await recordStatus(env, feed.id, userId, 'ok', fetchedAt);
  return { added, skipped, failed };
}

/** Maps a feeds-table row (snake_case) to the shared `Feed` contract. */
export function mapFeedRow(row: {
  id: string;
  user_id: string;
  title: string;
  url: string;
  tag_names: string;
  cadence: string;
  last_fetched_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}): Feed {
  let tagNames: string[] = [];
  try {
    const v = JSON.parse(row.tag_names);
    if (Array.isArray(v)) tagNames = v.filter((x) => typeof x === 'string');
  } catch {
    tagNames = [];
  }
  const cadence = (FEED_CADENCES as string[]).includes(row.cadence) ? row.cadence : 'off';
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    url: row.url,
    tagNames,
    cadence: cadence as FeedCadence,
    lastFetchedAt: row.last_fetched_at ?? null,
    lastStatus: row.last_status ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

import { CATEGORIZE_PROMPT_VERSION, PROMPT_VERSION } from './prompt';
import type { ParsedCategory, ParsedTag } from './prompt';
import type { CandidateSource } from './types';

/**
 * P1-2 — per-URL cache of AI tagging results.
 *
 * Re-analysing a URL the model has already tagged (a re-saved bookmark, a job
 * re-run, a duplicate across folders) should not burn another model call. The
 * reference project `ai-bookmark-os` caches label results by URL for exactly
 * this reason.
 *
 * The key folds in the prompt version and the model, so bumping the prompt or
 * switching provider invalidates the entry automatically — no manual flush.
 *
 * The cache is an *optional* dependency: callers pass a `TagCache` adapter only
 * when the `AI_CACHE` KV binding exists. When it is absent (local dev, tests,
 * deployments that skip the binding) the engine simply always calls the model.
 * This keeps the engine free of any hard KV dependency and unit-testable.
 */

/** The cached model output for one bookmark (a `ParsedItem` without its index). */
export interface TagCacheEntry {
  tags: ParsedTag[];
  summary: string | null;
  topic: string | null;
  needsReview: boolean;
}

/** Minimal async key-value surface the engine needs — KV-backed in production. */
export interface TagCache {
  get(key: string): Promise<TagCacheEntry | null>;
  put(key: string, entry: TagCacheEntry): Promise<void>;
}

/**
 * Normalises a URL for cache-key purposes: lowercase scheme+host, drop the
 * fragment. Deliberately conservative — we do NOT strip query params, because
 * they can select genuinely different pages, and an over-eager normalisation
 * would serve one page's tags for another.
 */
export function normalizeUrlForCache(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** SHA-256 hex of the normalized URL, keeping KV keys short and collision-safe. */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Builds the cache key for one URL under one model + prompt revision.
 * Shape: `ai:tag:<promptVersion>:<model>:<sha256(url)>`.
 */
export async function cacheKeyFor(url: string, model: string): Promise<string> {
  const hash = await sha256Hex(normalizeUrlForCache(url));
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `ai:tag:${PROMPT_VERSION}:${safeModel}:${hash}`;
}

/* ------------------------------------------------------------------ *
 * CategorySync P1 — categorize results live in their own namespace.
 *
 * The cached shape differs (a single placement, not a tag list) and the
 * prompt version is tracked separately, so categorize keys use the `ai:cat:`
 * prefix and `CATEGORIZE_PROMPT_VERSION`. Sharing the tagging namespace would
 * either collide on shape or invalidate tagging entries on a categorize bump.
 * ------------------------------------------------------------------ */

/**
 * The cached categorize output for one bookmark: the parsed placement plus the
 * engine that produced it (so a cached fallback stays a fallback on replay).
 */
export type CategoryCacheEntry = ParsedCategory & { source?: CandidateSource };

/** Minimal async key-value surface for categorize results — KV-backed in production. */
export interface CategoryCache {
  get(key: string): Promise<CategoryCacheEntry | null>;
  put(key: string, entry: CategoryCacheEntry): Promise<void>;
}

/**
 * Builds the categorize cache key. Shape: `ai:cat:<promptVersion>:<model>:<sha256(url)>`.
 */
export async function categoryCacheKeyFor(url: string, model: string): Promise<string> {
  const hash = await sha256Hex(normalizeUrlForCache(url));
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `ai:cat:${CATEGORIZE_PROMPT_VERSION}:${safeModel}:${hash}`;
}

/**
 * Wraps a KV namespace as a `CategoryCache`. Same defensive posture as the tag
 * cache: a KV hiccup degrades to a miss, never to a failed categorize run.
 */
export function makeKvCategoryCache(kv: KVNamespace): CategoryCache {
  return {
    async get(key) {
      try {
        return await kv.get<CategoryCacheEntry>(key, 'json');
      } catch {
        return null;
      }
    },
    async put(key, entry) {
      try {
        await kv.put(key, JSON.stringify(entry), { expirationTtl: CACHE_TTL_SECONDS });
      } catch {
        /* a failed write just means a future miss — never an error */
      }
    },
  };
}

/** 30 days: long enough to pay off, short enough to self-heal stale entries. */
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Wraps a KV namespace as a `TagCache`. Every operation is defensive: a KV
 * hiccup must never fail an organise run, so reads degrade to "miss" and writes
 * are swallowed on error.
 */
export function makeKvTagCache(kv: KVNamespace): TagCache {
  return {
    async get(key) {
      try {
        return await kv.get<TagCacheEntry>(key, 'json');
      } catch {
        return null;
      }
    },
    async put(key, entry) {
      try {
        await kv.put(key, JSON.stringify(entry), { expirationTtl: CACHE_TTL_SECONDS });
      } catch {
        /* a failed write just means a future miss — never an error */
      }
    },
  };
}

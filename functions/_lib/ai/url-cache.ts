import { CATEGORIZE_PROMPT_VERSION, PROMPT_VERSION, RENAME_PROMPT_VERSION } from './prompt';
import type { ParsedCategory, ParsedTag, ParsedRename } from './prompt';
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
 * Shape: `ai:tag:<promptVersion>:<model>[:<variant>]:<sha256(url)>`.
 *
 * D-3（审计核查结论）: `PROMPT_VERSION` 必须留在 key 里 —— 提示词一改，旧条目的
 * 输出口径就失效了；带上版本号等于「一次提示词升级自动使全部旧缓存作废」，
 * 无需手动清 KV。model 同理：不同模型的输出不可互换。请勿为了缩短 key 去掉它们。
 *
 * A-3（第二轮审计）: `variant` 把影响输出形态的配置开关折入 key。此前 key 只含
 * promptVersion + model + url，`autoSummarize`/`fetchContent`/`twoPass`/`maxTags`
 * 均不在其中——关闭摘要时写入的 `summary: null` 缓存，在开启摘要后命中同一 URL
 * 会永远拿不到摘要（TTL 30 天），配置切换后行为不一致且不可解释。现由调用方把
 * 这些开关编码成短标志位（见 `tagCacheVariant`）传入，切换配置即换 key、旧条目
 * 自然失效。缺省 `variant=''` 时 key 形态与旧版完全一致（向后兼容）。
 */
export async function cacheKeyFor(url: string, model: string, variant = ''): Promise<string> {
  const hash = await sha256Hex(normalizeUrlForCache(url));
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  const variantPart = variant ? `:${variant}` : '';
  return `ai:tag:${PROMPT_VERSION}:${safeModel}${variantPart}:${hash}`;
}

/**
 * A-3（第二轮审计）: 把影响打标输出形态的配置开关编码为一个短字符串，供
 * `cacheKeyFor` 折入 key。每个开关对应一个标志位：
 *   - `s1/s0` — autoSummarize（是否产出摘要）
 *   - `f1/f0` — fetchContent（是否抓取正文喂给模型，直接改变输入与输出）
 *   - `t1/t0` — twoPass（是否走粗→精二次细化）
 *   - `m{n}`  — maxTags（标签数上限，>0 时才编入）
 * 任一开关变化都会改变 variant，从而令旧缓存自动作废。纯函数、无副作用，便于单测。
 */
export function tagCacheVariant(config: {
  autoSummarize?: boolean;
  fetchContent?: boolean;
  twoPass?: boolean;
  maxTags?: number;
}): string {
  const parts: string[] = [
    config.autoSummarize ? 's1' : 's0',
    config.fetchContent ? 'f1' : 'f0',
    config.twoPass ? 't1' : 't0',
  ];
  if (typeof config.maxTags === 'number' && config.maxTags > 0) {
    parts.push(`m${Math.trunc(config.maxTags)}`);
  }
  return parts.join('.');
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

/* ------------------------------------------------------------------ *
 * Rename mode (structured-organise Phase B) — third cache namespace.
 *
 * The cached shape (a cleaned title) differs from both tagging and
 * categorize, and `RENAME_PROMPT_VERSION` is tracked separately, so
 * rename keys use the `ai:rename:` prefix. One caveat baked into the
 * entry: a URL's *original title* can legitimately change between runs
 * (the user edited it, or a sync pulled a new one), so the cached answer
 * is only a suggestion — the engine compares it against the current
 * title and falls through to "unchanged" when they already match.
 * ------------------------------------------------------------------ */

/** The cached rename output for one bookmark (a `ParsedRename`). */
export type RenameCacheEntry = ParsedRename;

/** Minimal async key-value surface for rename results — KV-backed in production. */
export interface RenameCache {
  get(key: string): Promise<RenameCacheEntry | null>;
  put(key: string, entry: RenameCacheEntry): Promise<void>;
}

/**
 * Builds the rename cache key. Shape: `ai:rename:<promptVersion>:<model>:<sha256(url)>`.
 */
export async function renameCacheKeyFor(url: string, model: string): Promise<string> {
  const hash = await sha256Hex(normalizeUrlForCache(url));
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `ai:rename:${RENAME_PROMPT_VERSION}:${safeModel}:${hash}`;
}

/**
 * Wraps a KV namespace as a `RenameCache`. Same defensive posture as the
 * other caches: a KV hiccup degrades to a miss, never to a failed rename run.
 */
export function makeKvRenameCache(kv: KVNamespace): RenameCache {
  return {
    async get(key) {
      try {
        return await kv.get<RenameCacheEntry>(key, 'json');
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

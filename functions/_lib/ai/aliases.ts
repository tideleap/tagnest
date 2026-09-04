import type { AiConfig, VocabEntry } from './types';
import { normalizeKey, SYNONYMS } from './taxonomy';
import { callProvider } from './providers';
import { loadVocabulary, parseAliases } from './config';
import type { Env } from '../env';
import { PRIVATE_BOOKMARK_CLAUSE, queryInChunks } from '../db';

/**
 * Semantic aggregation + automatic alias expansion.
 *
 * Two halves:
 *
 *  1. **Offline alias suggestions** — every existing tag is checked against the
 *     seed synonym table (`SYNONYMS` in `taxonomy.ts`). A CJK tag like 前端
 *     yields its Latin variants (frontend, fe, 前端开发, 客户端); a Latin tag
 *     that is a synonym key yields its canonical spelling plus its siblings.
 *     These are *proposals*: the user confirms them before they are written to
 *     `tags.aliases`, where the normaliser already folds them in.
 *
 *  2. **Topic clustering of pending suggestions** — the model tags each
 *     bookmark with a one-phrase `topic` (Phase 1). Grouping the review queue
 *     by that topic gives the user a fast "what did this run actually touch?"
 *     view and a natural unit for batch accept/ignore (Phase 4).
 *
 * Both are deliberately cheap and synchronous where they can be, so the audit
 * page renders instantly and the model is only touched on explicit request
 * ("用 AI 生成更多").
 */

/** Reverse index: canonical spelling → the keys that fold into it. */
const REVERSE_SYNONYMS: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const [key, canonical] of Object.entries(SYNONYMS)) {
    (map[canonical] ??= []).push(key);
  }
  return map;
})();

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface AliasSuggestion {
  tagId: string;
  tagName: string;
  /** Proposed spellings not already covered by the tag. */
  aliases: string[];
  /** Why these were proposed — drives the UI hint. */
  reason: string;
}

export interface TopicCluster {
  topic: string;
  /** Distinct bookmarks carrying this topic. */
  bookmarkCount: number;
  /** Distinct tag names proposed under this topic (capped). */
  tagNames: string[];
}

/* ------------------------------------------------------------------ *
 * Offline alias generation (pure)
 * ------------------------------------------------------------------ */

export interface AliasBuildOptions {
  /** Skip tags that already carry at least this many aliases. */
  minExistingAliases?: number;
  /** Cap on proposed aliases per tag. */
  maxAliases?: number;
}

/**
 * Proposes alias spellings for tags that have few of their own.
 *
 * Pure and synchronous so it unit-tests without a database. The proposals are
 * deliberately conservative — only spellings we can justify from the seed
 * synonym table, never a guess at what a tag "means".
 */
export function buildAliasSuggestions(
  entries: VocabEntry[],
  opts: AliasBuildOptions = {},
): AliasSuggestion[] {
  const minExisting = opts.minExistingAliases ?? 3;
  const maxAliases = opts.maxAliases ?? 5;
  const out: AliasSuggestion[] = [];

  for (const entry of entries) {
    if (entry.aliases.length >= minExisting) continue;

    const owned = new Set(entry.aliases.map(normalizeKey));
    const tagKey = normalizeKey(entry.name);
    const proposed = new Set<string>();

    const add = (candidate: string) => {
      const c = candidate.trim();
      if (!c) return;
      const key = normalizeKey(c);
      if (key === tagKey || owned.has(key) || proposed.has(c)) return;
      proposed.add(c);
    };

    // Case A: the tag name is a canonical value — surface every key that folds
    // into it (前端 → frontend, fe, 前端开发, 客户端).
    for (const key of REVERSE_SYNONYMS[entry.name] ?? []) add(key);

    // Case B: the tag name is itself a synonym key — propose the canonical
    // spelling and its siblings (React-like cases where the table knows more).
    const canonical = SYNONYMS[tagKey];
    if (canonical) {
      add(canonical);
      for (const key of REVERSE_SYNONYMS[canonical] ?? []) add(key);
    }

    const aliases = [...proposed].slice(0, maxAliases);
    if (aliases.length > 0) {
      out.push({
        tagId: entry.id,
        tagName: entry.name,
        aliases,
        reason: '同义词 / 近义词（离线词表）',
      });
    }
  }

  // Most-used, highest-value tags first so the audit shows the best wins.
  // B-21: sort by live usage count (the comment's promise), not by tag id —
  // the old `tagId.localeCompare` ordered by opaque identifier and never by value.
  const countById = new Map(entries.map((e) => [e.id, e.count]));
  return out.sort(
    (a, b) => (countById.get(b.tagId) ?? 0) - (countById.get(a.tagId) ?? 0),
  );
}

/* ------------------------------------------------------------------ *
 * Topic clustering of pending suggestions (pure + DB)
 * ------------------------------------------------------------------ */

export interface SuggestionTopicRow {
  topic: string | null;
  tagName: string;
  bookmarkId: string;
}

/**
 * Groups pending-suggestion rows by their model-supplied topic.
 *
 * Pure: the caller hands in already-fetched rows so this is trivially
 * testable. `tag_suggestions.topic` is what the model wrote in Phase 1; absent
 * a model it falls back to the top tag name, so even fallback-only runs
 * produce a usable distribution.
 */
export function clusterSuggestionsByTopic(rows: SuggestionTopicRow[]): TopicCluster[] {
  const map = new Map<string, TopicCluster & { ids: Set<string>; keys: Set<string> }>();

  for (const r of rows) {
    const topic = r.topic?.trim() || '未分类';
    let cluster = map.get(topic);
    if (!cluster) {
      cluster = { topic, bookmarkCount: 0, tagNames: [], ids: new Set(), keys: new Set() };
      map.set(topic, cluster);
    }
    if (!cluster.ids.has(r.bookmarkId)) {
      cluster.ids.add(r.bookmarkId);
      cluster.bookmarkCount += 1;
    }
    const key = normalizeKey(r.tagName);
    if (!cluster.keys.has(key)) {
      cluster.keys.add(key);
      cluster.tagNames.push(r.tagName);
    }
  }

  return [...map.values()]
    .map(({ ids: _ids, keys: _keys, ...rest }) => ({
      ...rest,
      tagNames: rest.tagNames.slice(0, 12),
    }))
    .sort((a, b) => b.bookmarkCount - a.bookmarkCount);
}

/** Fetches and clusters the user's pending suggestions by topic. */
export async function loadTopicClusters(
  env: Env,
  userId: string,
  jobId?: string | null,
): Promise<TopicCluster[]> {
  const jobClause = jobId ? 'AND s.job_id = ?' : '';
  const params = jobId ? [userId, jobId] : [userId];

  // Mirrors listPendingSuggestions: private bookmarks never enter the review
  // queue, so they must not enter the topic clustering that groups it either.
  const rows = await env.DB.prepare(
    `SELECT s.topic AS topic, s.tag_name AS tag_name, s.bookmark_id AS bookmark_id
       FROM tag_suggestions s
       JOIN bookmarks b ON b.id = s.bookmark_id AND b.deleted_at IS NULL
            AND ${PRIVATE_BOOKMARK_CLAUSE}
      WHERE s.user_id = ? AND s.status = 'pending' ${jobClause}`,
  )
    .bind(...params)
    .all<Record<string, unknown>>();

  return clusterSuggestionsByTopic(
    rows.results.map((row) => ({
      topic: (row.topic as string | null) ?? null,
      tagName: String(row.tag_name),
      bookmarkId: String(row.bookmark_id),
    })),
  );
}

/* ------------------------------------------------------------------ *
 * Persistence: apply confirmed aliases to tags.aliases
 * ------------------------------------------------------------------ */

export interface ApplyAliasItem {
  tagId: string;
  aliases: string[];
}

/**
 * Appends confirmed aliases to each tag's `aliases` column (JSON array).
 *
 * De-duplicates against the tag's existing aliases *and its own name* by
 * normalised key, so accepting "前端" for the tag 前端 is a no-op rather than a
 * pointless row write. Returns how many tags actually changed — the UI uses it
 * for the success toast, and it is what makes re-applying idempotent.
 */
export async function applyAliases(
  env: Env,
  userId: string,
  items: ApplyAliasItem[],
): Promise<{ updated: number }> {
  // A-5（第二轮审计）: one chunked read + one batched write replace the old
  // per-item SELECT+UPDATE (N+1 round trips) and the double `parseAliases`.
  // Merge aliases per tagId first so duplicate tagIds in one payload behave
  // exactly like the old sequential application (dedupe is order-preserving).
  const wanted = new Map<string, string[]>();
  for (const item of items) {
    if (!item.tagId || !Array.isArray(item.aliases) || item.aliases.length === 0) continue;
    const list = wanted.get(item.tagId) ?? [];
    for (const raw of item.aliases) list.push(String(raw));
    wanted.set(item.tagId, list);
  }
  if (wanted.size === 0) return { updated: 0 };

  const rows = await queryInChunks<{ id: string; name: string; aliases: string | null }>(
    env.DB,
    [...wanted.keys()],
    [userId],
    (ph) => `SELECT id, name, aliases FROM tags WHERE user_id = ? AND id IN (${ph})`,
    (row) => row,
  );

  const updates: D1PreparedStatement[] = [];
  for (const row of rows) {
    const incoming = wanted.get(row.id);
    if (!incoming) continue;

    const existing = parseAliases(row.aliases);
    const merged = [...existing];
    const seen = new Set(merged.map(normalizeKey));
    seen.add(normalizeKey(String(row.name)));

    for (const raw of incoming) {
      const candidate = raw.trim();
      if (!candidate) continue;
      const key = normalizeKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
    }

    if (merged.length === existing.length) continue;

    updates.push(
      env.DB.prepare(`UPDATE tags SET aliases = ? WHERE id = ? AND user_id = ?`).bind(
        JSON.stringify(merged),
        row.id,
        userId,
      ),
    );
  }

  for (let i = 0; i < updates.length; i += 90) {
    await env.DB.batch(updates.slice(i, i + 90));
  }

  return { updated: updates.length };
}

/** Loads offline alias proposals for the whole vocabulary. */
export async function loadAliasSuggestions(env: Env, userId: string): Promise<AliasSuggestion[]> {
  const vocab = await loadVocabulary(env, userId);
  return buildAliasSuggestions(vocab.entries);
}

/* ------------------------------------------------------------------ *
 * Model-assisted alias generation (optional, on demand)
 * ------------------------------------------------------------------ */

/**
 * Builds the prompt for the "用 AI 生成更多" action.
 *
 * Asks for a small, conservative set of synonyms / near-synonyms / common
 * English spellings per tag, returned as a `{ aliases: { tag: [...] } }` map.
 * The model is explicitly told not to invent meanings — only spellings a
 * human would recognise as the same concept.
 */
export function buildAliasPrompt(tagNames: string[]): string {
  const list = tagNames.map((t) => `- ${t}`).join('\n');
  return [
    '你是一个书签管理应用的标签同义词助手。下面是用户已有的标签名：',
    '',
    list,
    '',
    '请为每个标签给出 3-5 个"同义 / 近义 / 常见英文 / 常见拼写变体"表达，',
    '用于后续自动归一化（例如 前端 的同义词可包含 frontend、fe）。',
    '只给拼写变体，不要编造标签的含义；不要重复标签名本身。',
    '只输出一个 JSON 对象，格式严格如下，不要包含任何解释文字：',
    '{"aliases": {"标签名": ["同义词1", "同义词2"]}}',
  ].join('\n');
}

/**
 * Parses the model's alias map, tolerating the usual malformed output.
 *
 * Returns one `AliasSuggestion` per tag that produced at least one usable
 * alias. Unknown tags in the response are dropped, and a `tagNames` hint lets
 * the caller re-attached the id afterwards.
 */
export function parseAliasResponse(text: string, tagNames: string[]): AliasSuggestion[] {
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    return [];
  }

  const map = (parsed as { aliases?: Record<string, unknown> } | null)?.aliases;
  if (!map || typeof map !== 'object') return [];

  const known = new Set(tagNames);
  const out: AliasSuggestion[] = [];

  for (const [tag, value] of Object.entries(map)) {
    if (!known.has(tag)) continue;
    if (!Array.isArray(value)) continue;
    const aliases = value
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (aliases.length > 0) {
      out.push({ tagId: '', tagName: tag, aliases, reason: 'AI 生成' });
    }
  }
  return out;
}

/**
 * Calls the model to expand aliases for the given tag names.
 *
 * Never throws — a failed or empty model response simply yields `[]` and the
 * caller falls back to offline suggestions. This is the same "degrade, don't
 * disappear" contract the rest of the AI feature follows.
 */
export async function generateModelAliases(
  config: AiConfig,
  tagNames: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<AliasSuggestion[]> {
  if (tagNames.length === 0) return [];
  const prompt = buildAliasPrompt(tagNames);
  const result = await callProvider(config, prompt, fetchImpl);
  if (!result.ok || !result.text) return [];
  return parseAliasResponse(result.text, tagNames);
}

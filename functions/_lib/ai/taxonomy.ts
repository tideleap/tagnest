import type { TagCandidate, VocabEntry, Vocabulary } from './types';

/**
 * Taxonomy normalisation — the piece that decides whether AI tagging makes a
 * library tidier or messier.
 *
 * A model asked "what is this page about?" answers in whatever words fit the
 * page. Across a thousand bookmarks it will emit 前端, Frontend, front-end and
 * 前端开发 for the same idea, and a naive pipeline dutifully creates four tags.
 * The result is worse than no tagging at all, because now the user has a mess
 * they did not make by hand.
 *
 * So model output is never trusted as a tag name. It is treated as an
 * *intent*, resolved against the user's existing vocabulary in four passes,
 * cheapest first:
 *
 *   1. exact key match      "React " -> react     -> existing tag
 *   2. alias match          "front-end"           -> tag that absorbed it
 *   3. synonym canonicalise "JS"                  -> JavaScript
 *   4. fuzzy match          "kubernets"           -> kubernetes (edit distance)
 *
 * Only when all four miss does a new tag get proposed. Every reuse also raises
 * the candidate's confidence, because agreeing with a decision the user has
 * already made is a safer bet than inventing a category.
 *
 * All functions here are pure and synchronous so the behaviour is unit-testable
 * without a database.
 */

/** Fuzzy matching only applies from this length up; short words differ meaningfully. */
const FUZZY_MIN_LENGTH = 4;

/** Normalised-similarity threshold for treating two tags as the same. */
const FUZZY_THRESHOLD = 0.86;

/**
 * Seed synonyms folded into a canonical spelling.
 *
 * Deliberately small and uncontroversial: abbreviations and the CJK/Latin pairs
 * that split a taxonomy fastest. It is a starting vocabulary, not an ontology —
 * anything domain-specific is learned from the user's own tags and aliases,
 * which always take precedence over this table.
 */
export const SYNONYMS: Record<string, string> = {
  // Frontend
  frontend: '前端',
  fe: '前端',
  前端开发: '前端',
  客户端: '前端',
  // Backend
  backend: '后端',
  be: '后端',
  后端开发: '后端',
  服务端: '后端',
  // Languages and runtimes
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  py: 'Python',
  python: 'Python',
  golang: 'Go',
  // Concepts
  ai: '人工智能',
  artificialintelligence: '人工智能',
  ml: '机器学习',
  machinelearning: '机器学习',
  llm: '大模型',
  largelanguagemodel: '大模型',
  deeplearning: '深度学习',
  设计: '设计',
  design: '设计',
  ui: '设计',
  ux: '设计',
  教程: '教程',
  tutorial: '教程',
  guide: '教程',
  文档: '文档',
  docs: '文档',
  documentation: '文档',
  工具: '工具',
  tool: '工具',
  tools: '工具',
  开源: '开源',
  opensource: '开源',
  博客: '博客',
  blog: '博客',
  新闻: '新闻',
  news: '新闻',
  论文: '论文',
  paper: '论文',
  视频: '视频',
  video: '视频',
  产品: '产品',
  product: '产品',
  运维: '运维',
  devops: '运维',
  数据库: '数据库',
  database: '数据库',
  db: '数据库',
  安全: '安全',
  security: '安全',
  云服务: '云服务',
  cloud: '云服务',
  求职: '求职',
  面试: '面试',
  interview: '面试',
};

/**
 * B-9（第二轮审计）: 语言名白名单。`+` 与 `#` 在 C++/C#/F# 里是名称的一部分，
 * 但分隔符正则会剥离 `+`，使 `c++` → `c`，与裸「C」标签碰撞——`buildVocabulary`
 * 会把 C++/C 视为同一标签（计数高者赢），`findDuplicateClusters` 会建议合并两个
 * 完全不同的技术标签。归一化前先按白名单整体保护这些名称（大小写不敏感），命中
 * 即原样返回小写形式，不再走剥离逻辑。
 *
 * 刻意只收录 `+`/`#` 语义必需项：`node.js`/`vue.js` 等含 `.` 的名称**不入**白名单，
 * 否则 `node.js` 与 `nodejs` 将不再归一为同一 key，反而破坏既有去重（grouping.ts
 * 的分类规则同时列有 'nodejs' 与 'node.js'，依赖二者归一）。
 */
const LANGUAGE_NAME_WHITELIST = new Set(['c++', 'c#', 'f#']);

/**
 * Reduces a tag name to a comparison key.
 *
 * Strips the differences that are never semantic: case, full-width forms,
 * separators, and English plurals. "Front-End", "front end" and "frontend" all
 * collapse to `frontend`, which is what makes duplicate detection possible at
 * all.
 */
export function normalizeKey(name: string): string {
  let key = name.normalize('NFKC').trim().toLowerCase();

  // B-9（第二轮审计）: 语言名白名单整体保护，`c++`/`c#`/`f#` 不再被剥成 `c`/`f`。
  if (LANGUAGE_NAME_WHITELIST.has(key)) return key;

  // Separators carry no meaning in a tag: "front-end" == "front end".
  key = key.replace(/[\s\-_.·・/\\|,，、+&]+/g, '');

  // Decorative punctuation only.
  key = key.replace(/["'`“”‘’()（）[\]{}<>!！?？:：;；]/g, '');

  // B-9（第二轮审计）: 剥离装饰符后若整体恰为白名单语言名（如 `"c#"` 引号包裹、
  // `（f#）` 括号包裹），同样保护，不被后续复数规则截断。
  if (LANGUAGE_NAME_WHITELIST.has(key)) return key;

  // English plurals. Guarded by length so "css" and "js" survive intact.
  if (/[a-z]$/.test(key)) {
    if (key.length > 4 && key.endsWith('ies')) key = `${key.slice(0, -3)}y`;
    else if (key.length > 4 && /(ches|shes|xes|ses)$/.test(key)) key = key.slice(0, -2);
    else if (key.length > 3 && key.endsWith('s') && !key.endsWith('ss')) key = key.slice(0, -1);
  }

  return key;
}

/** Canonical spelling for a key, or null when we have no opinion. */
export function canonicalSynonym(key: string): string | null {
  return SYNONYMS[key] ?? null;
}

/** Levenshtein distance, two-row rolling buffer. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/** 0..1 similarity derived from edit distance. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/**
 * Indexes the user's tags for normalisation.
 *
 * When two existing tags collapse to the same key (the user already has both
 * "front-end" and "frontend"), the more-used one wins the index slot: new
 * suggestions then flow to the tag the user actually works with. The loser is
 * not hidden — `findDuplicateClusters` reports it so the taxonomy audit can
 * offer a merge.
 */
export function buildVocabulary(entries: VocabEntry[]): Vocabulary {
  const byKey = new Map<string, VocabEntry>();
  const byId = new Map<string, VocabEntry>();
  const byName = new Map<string, VocabEntry>();

  for (const entry of entries) {
    // First-match-wins mirrors the old `entries.find` semantics for both
    // id and name lookups (duplicate ids/names keep the earliest entry).
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
    const nameKey = normalizeKey(entry.name);
    // Keep the FIRST entry in array order for a given name key — that is what
    // the old `entries.find` fallback returned; do not re-rank by count here.
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, entry);
    const keys = [entry.name, ...entry.aliases].map(normalizeKey).filter(Boolean);
    for (const key of keys) {
      const held = byKey.get(key);
      if (!held || entry.count > held.count) byKey.set(key, entry);
    }
  }

  return { entries, byKey, byId, byName };
}

export interface ResolveResult {
  name: string;
  tagId: string | null;
  /** Multiplier applied to the raw candidate confidence. */
  confidenceFactor: number;
  reason: string;
}

/**
 * Resolves a raw tag name against the existing taxonomy.
 *
 * The confidence factor encodes how much the resolution itself tells us:
 * reusing a tag the user already curated is strong evidence the suggestion is
 * right (1.15), inventing a brand new category is weaker (0.85). This is what
 * pushes the pipeline toward a small, stable tag set over time instead of an
 * ever-growing one.
 */
export function resolveTagName(raw: string, vocab: Vocabulary): ResolveResult | null {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;

  const key = normalizeKey(cleaned);
  if (!key) return null;

  // 1 + 2) Exact match on a name or a folded alias.
  const direct = vocab.byKey.get(key);
  if (direct) {
    return {
      name: direct.name,
      tagId: direct.id,
      confidenceFactor: 1.15,
      reason: '复用已有标签',
    };
  }

  // 3) Canonical spelling, then retry the index.
  const canonical = canonicalSynonym(key);
  if (canonical) {
    const viaSynonym = vocab.byKey.get(normalizeKey(canonical));
    if (viaSynonym) {
      return {
        name: viaSynonym.name,
        tagId: viaSynonym.id,
        confidenceFactor: 1.1,
        reason: `归一到已有标签（${cleaned}）`,
      };
    }
    // No existing tag, but we still prefer the canonical spelling so the tag
    // created now is the one future runs will match against.
    return {
      name: canonical,
      tagId: null,
      confidenceFactor: 0.95,
      reason: `新标签，规范化自「${cleaned}」`,
    };
  }

  // 4) Fuzzy match against existing tags — catches typos and near-spellings.
  if (key.length >= FUZZY_MIN_LENGTH) {
    let best: { entry: VocabEntry; score: number } | null = null;
    for (const entry of vocab.entries) {
      const entryKey = normalizeKey(entry.name);
      if (entryKey.length < FUZZY_MIN_LENGTH) continue;
      const score = similarity(key, entryKey);
      if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
        best = { entry, score };
      }
    }
    if (best) {
      return {
        name: best.entry.name,
        tagId: best.entry.id,
        confidenceFactor: 1.05,
        reason: `近似已有标签「${best.entry.name}」`,
      };
    }
  }

  return { name: cleaned, tagId: null, confidenceFactor: 0.85, reason: '新标签' };
}

/**
 * Normalises, scores, de-duplicates and truncates a batch of raw candidates.
 *
 * The model is the sole tag generator, so all candidates in a batch share one
 * source; spelling variants that resolve to the same tag (the model proposed
 * both "前端" and "frontend") are merged into a single proposal keeping the
 * stronger confidence rather than double-counting the same idea.
 */
export function resolveCandidates(
  raw: Array<{ name: string; confidence: number; source: TagCandidate['source']; reason?: string }>,
  vocab: Vocabulary,
  maxTags: number,
): TagCandidate[] {
  const merged = new Map<string, TagCandidate>();

  for (const item of raw) {
    const resolved = resolveTagName(item.name, vocab);
    if (!resolved) continue;

    const confidence = Math.min(1, Math.max(0, item.confidence * resolved.confidenceFactor));
    const dedupeKey = resolved.tagId ?? normalizeKey(resolved.name);
    const held = merged.get(dedupeKey);

    if (!held) {
      merged.set(dedupeKey, {
        name: resolved.name,
        tagId: resolved.tagId,
        confidence,
        source: item.source,
        reason: item.reason ? `${item.reason} · ${resolved.reason}` : resolved.reason,
      });
      continue;
    }

    // Same tag reached twice: keep the stronger claim.
    held.confidence = Math.max(held.confidence, confidence);
  }

  return [...merged.values()]
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, maxTags));
}

export interface DuplicateCluster {
  /** The tag to keep — the most-used member. */
  canonical: VocabEntry;
  /** Tags proposed for folding into `canonical`. */
  duplicates: VocabEntry[];
  reason: string;
}

/**
 * Finds groups of tags that mean the same thing.
 *
 * Powers the taxonomy audit: rather than asking the user to spot "工具" and
 * "Tools" among four hundred tags themselves, the audit hands them a merge
 * list. This is the automatic maintenance half of the feature — tidying an
 * existing mess, not just avoiding new ones.
 */
export function findDuplicateClusters(vocab: Vocabulary): DuplicateCluster[] {
  const byKey = new Map<string, VocabEntry[]>();

  for (const entry of vocab.entries) {
    const key = normalizeKey(entry.name);
    if (!key) continue;
    const canonical = canonicalSynonym(key) ?? key;
    const bucket = normalizeKey(canonical);
    const list = byKey.get(bucket);
    if (list) list.push(entry);
    else byKey.set(bucket, [entry]);
  }

  const clusters: DuplicateCluster[] = [];
  const claimed = new Set<string>();

  // Pass 1: exact key / synonym collisions. High confidence, no threshold.
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => b.count - a.count);
    const [canonical, ...duplicates] = sorted;
    clusters.push({ canonical, duplicates, reason: '归一化后名称相同' });
    for (const entry of sorted) claimed.add(entry.id);
  }

  // Pass 2: fuzzy neighbours among what is left.
  const remaining = vocab.entries
    .filter((e) => !claimed.has(e.id))
    .sort((a, b) => b.count - a.count);

  for (let i = 0; i < remaining.length; i += 1) {
    const anchor = remaining[i];
    if (claimed.has(anchor.id)) continue;
    const anchorKey = normalizeKey(anchor.name);
    if (anchorKey.length < FUZZY_MIN_LENGTH) continue;

    const duplicates: VocabEntry[] = [];
    for (let j = i + 1; j < remaining.length; j += 1) {
      const other = remaining[j];
      if (claimed.has(other.id)) continue;
      const otherKey = normalizeKey(other.name);
      if (otherKey.length < FUZZY_MIN_LENGTH) continue;
      if (similarity(anchorKey, otherKey) >= FUZZY_THRESHOLD) {
        duplicates.push(other);
        claimed.add(other.id);
      }
    }

    if (duplicates.length > 0) {
      claimed.add(anchor.id);
      clusters.push({ canonical: anchor, duplicates, reason: '拼写高度相似' });
    }
  }

  return clusters.sort(
    (a, b) =>
      b.duplicates.length - a.duplicates.length ||
      b.canonical.count - a.canonical.count,
  );
}

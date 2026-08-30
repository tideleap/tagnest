import { callProvider, isFatal, isTransientRetryable, withRetry } from './providers';
import { extractJsonValue, MAX_TAG_LENGTH } from './prompt';
import type { AiConfig, RawCandidate } from './types';

/**
 * P0-1 — classification-tree synthesis (Map-Reduce "reduce" step).
 *
 * The reference project `ai-bookmark-os` runs a three-stage pyramid:
 * label → buildTree → assign. TagNest already labels per-bookmark; this module
 * is the missing middle: after a batch is tagged, aggregate the tag frequencies
 * and ask the model to organise the flat tag list into a bounded hierarchy
 * (≤3 levels, ≤10 top categories), then attach each tag's parent category back
 * onto the bookmarks ("补父标签"). The result is a consistent taxonomy instead
 * of a fragmented pile of independent tags — the direct fix for "不够全面".
 */

/** One node in the synthesized hierarchy. */
export interface TaxonomyNode {
  name: string;
  children: TaxonomyNode[];
}

/** A tag and how often the batch surfaced it — the input to synthesis. */
export interface TagCount {
  name: string;
  count: number;
}

const MAX_TREE_LEVELS = 3;
const MAX_TOP_CATEGORIES = 10;
/** Below this many distinct tags there is nothing worth organising. */
const TREE_MIN_TAGS = 8;

/**
 * P2-2 — incremental-classification imbalance threshold.
 *
 * When an incremental run introduces NEW tags making up at least this share of
 * the combined taxonomy (new + pre-existing), the pass has drifted far enough
 * from the established tree that merging it in produces a fragmented result.
 * The reference project `ai-bookmark-os` uses the same 30% figure in its
 * `classifyIncremental`; hitting it is the cue to suggest a full re-classify
 * rather than keep layering increments onto a stale tree.
 */
export const REBALANCE_THRESHOLD = 0.3;

/**
 * Pure decision: should the run surface a "consider a full re-classify" warning?
 *
 * `newTags` = tags this run proposed that do not resolve to an existing tag
 * (tag_id NULL). `existingTags` = tags already in the user's taxonomy before
 * the run. Returns true when the new share is ≥ REBALANCE_THRESHOLD and there
 * is at least one new tag (an all-reuse run never warns).
 */
export function shouldWarnRebalance(newTags: number, existingTags: number): boolean {
  if (newTags <= 0) return false;
  const total = newTags + existingTags;
  if (total <= 0) return false;
  return newTags / total >= REBALANCE_THRESHOLD;
}

/**
 * Builds the "reduce" prompt: turn a frequency-weighted flat tag list into a
 * bounded hierarchy. The model is shown counts so it can promote high-frequency
 * tags to categories and nest the rest beneath them.
 */
export function buildTreePrompt(tags: TagCount[]): string {
  const list = tags
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((t) => `- ${t.name}（出现 ${t.count} 次）`)
    .join('\n');
  return [
    '你是书签分类体系设计师。下面是一批书签被打上的扁平标签及其出现次数。',
    '请将它们组织成一个层级分类树，使同类标签归到同一父级之下。',
    '',
    '规则：',
    `- 最多 ${MAX_TOP_CATEGORIES} 个一级分类（顶层类别）。`,
    `- 最多 ${MAX_TREE_LEVELS} 层（顶层 → 子级 → 叶子）。`,
    '- 每个标签只能属于一个父级；无法归类的标签放到「其他」之下。',
    '- 父级名称应具体、可复用，避免使用「分类」「标签」这类空泛词。',
    `- 标签名 ≤ ${MAX_TAG_LENGTH} 字。`,
    '',
    '输出格式：仅输出一个 JSON 数组，不要代码块、不要解释。',
    'schema: [{"name":"一级分类","children":[{"name":"子分类"},{"name":"另一个子分类"}]}]',
    '没有子级的分类写成 {"name":"X"} 即可。',
    '',
    '待组织的标签（按出现次数降序）：',
    list,
    '',
    '仅输出一个 JSON 数组，不要代码块、不要解释。',
  ].join('\n');
}

/** Coerces one raw node into a bounded tree node, dropping malformed input. */
function normalizeNode(raw: unknown, depth: number): TaxonomyNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as { name?: unknown; children?: unknown };
  const name = typeof node.name === 'string' ? node.name.trim().slice(0, MAX_TAG_LENGTH) : '';
  if (!name) return null;
  let children: TaxonomyNode[] = [];
  if (depth < MAX_TREE_LEVELS && Array.isArray(node.children)) {
    children = node.children
      .map((c) => normalizeNode(c, depth + 1))
      .filter((c): c is TaxonomyNode => c !== null);
  }
  return { name, children };
}

/**
 * Parses a model tree response into a bounded taxonomy.
 *
 * Accepts an array-root (`[{...}]`) or a wrapper object (`{tree:[...]}` /
 * `{categories:[...]}` / `{nodes:[...]}`). Defends against runaway depth and an
 * unbounded top level by capping at 3 levels / 10 top categories. Returns `[]`
 * when there is nothing usable — never throws.
 */
export function parseTreeResponse(raw: string | null): TaxonomyNode[] {
  const parsed = extractJsonValue(raw);
  if (parsed === null) return [];
  const wrapper = parsed as { tree?: unknown; categories?: unknown; nodes?: unknown };
  const arr = Array.isArray(parsed)
    ? parsed
    : (wrapper.tree ?? wrapper.categories ?? wrapper.nodes);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((n) => normalizeNode(n, 1))
    .filter((n): n is TaxonomyNode => n !== null)
    .slice(0, MAX_TOP_CATEGORIES);
}

/**
 * Given a bookmark's raw tag candidates and the synthesized taxonomy, returns a
 * new candidate list with each tag's immediate parent category appended (the
 * "补父标签" step). A parent is added only when it is not already present and is
 * not the tag itself, preventing duplicates and self-cycles. The parent is
 * marked model-derived so it flows through scoring and review like any tag.
 */
export function attachParentTags(tags: RawCandidate[], tree: TaxonomyNode[]): RawCandidate[] {
  const parentOf = new Map<string, string>();
  const walk = (nodes: TaxonomyNode[]) => {
    for (const node of nodes) {
      for (const child of node.children) {
        parentOf.set(child.name.toLowerCase(), node.name);
      }
      walk(node.children);
    }
  };
  walk(tree);

  if (parentOf.size === 0) return tags;
  const have = new Set(tags.map((t) => t.name.toLowerCase()));
  const extra: RawCandidate[] = [];
  for (const tag of tags) {
    const parent = parentOf.get(tag.name.toLowerCase());
    if (!parent) continue;
    const parentKey = parent.toLowerCase();
    if (have.has(parentKey) || parentKey === tag.name.toLowerCase()) continue;
    have.add(parentKey);
    extra.push({
      name: parent,
      confidence: 0.5,
      source: 'model',
      reason: `由分类树推导的父级分类（${tag.name} ∈ ${parent}）`,
    });
  }
  return extra.length > 0 ? [...tags, ...extra] : tags;
}

export interface SynthesizeResult {
  tree: TaxonomyNode[];
  fatal: boolean;
  error: string | null;
}

/**
 * Map-Reduce "reduce": turns the batch's aggregated tag frequencies into a
 * consistent hierarchy. Skips (empty tree, no model call) when there is too
 * little signal to organise. Retries transient failures and stops the job on a
 * fatal provider error, mirroring the tagging path.
 */
export async function synthesizeTaxonomy(
  tags: TagCount[],
  config: AiConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SynthesizeResult> {
  if (tags.length < TREE_MIN_TAGS) return { tree: [], fatal: false, error: null };

  const prompt = buildTreePrompt(tags);
  const result = await withRetry(
    () => callProvider(config, prompt, fetchImpl),
    (outcome) => {
      if (!outcome.ok) {
        if (isFatal(outcome.error)) return 'stop';
        if (isTransientRetryable(outcome.error)) return 'retry';
        return 'stop';
      }
      // A successful response that parses to nothing: retrying the identical
      // prompt rarely helps, so degrade rather than burn more calls.
      return parseTreeResponse(outcome.text).length > 0 ? 'ok' : 'stop';
    },
  );

  if (result.ok) return { tree: parseTreeResponse(result.text), fatal: false, error: null };
  return {
    tree: [],
    fatal: isFatal(result.error),
    error: result.error?.message ?? '模型调用失败',
  };
}

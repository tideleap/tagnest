import type { EnrichInput, VocabEntry, Vocabulary } from './types';

/**
 * Prompt construction and response parsing.
 *
 * Two accuracy wins drive this module:
 *
 *  1. **Taxonomy as label set, not suggestion.** The model is shown the user's
 *     existing tags and instructed to classify against them. This converts an
 *     open-ended generation task into a constrained classification task, which
 *     is easier for the model and eliminates "前端 / Frontend / 前端开发"
 *     style duplicates.
 *
 *  2. **Structured I/O.** The prompt embeds a JSON schema and a few-shot block.
 *     The parser validates against that schema rather than silently swallowing
 *     malformed output. A single bad bookmark does not fail a 500-bookmark job.
 */

/**
 * How many existing tags to show.
 *
 * Raised from 60 to 120 (方案D): with only 60 slots, users with a large
 * taxonomy saw their low-frequency-but-relevant tags truncated, forcing the
 * model to invent near-duplicates. 120 doubles coverage while staying well
 * inside a reasonable prompt budget.
 */
const VOCAB_LIMIT = 120;

/** Bookmarks per model request. */
export const BATCH_SIZE = 10;

const MAX_TITLE = 160;
const MAX_DESCRIPTION = 400;
/** Page excerpt budget per bookmark (方案A). */
const MAX_EXCERPT = 500;

export const MAX_TAG_LENGTH = 24;
export const MAX_SUMMARY_LENGTH = 200;
export const MAX_TOPIC_LENGTH = 40;
export const MAX_REASON_LENGTH = 24;

/**
 * The prompt template revision currently in production.
 *
 * Every organise run stamps this onto its `ai_jobs.prompt_version` row, so the
 * acceptance metrics collected in Phase 5 can be sliced by revision. Bump the
 * string whenever the tagging prompt or its few-shot / schema block changes
 * meaningfully — that is what lets a future "did the new prompt do better?"
 * comparison be more than a guess. It is a plain date tag, not a semver, so the
 * value reads as "the prompt that shipped on this day" in logs and dashboards.
 */
export const PROMPT_VERSION = '2026-08-21';

/**
 * Version tag for the *categorize* prompt (CategorySync P1, C1-1).
 *
 * Tracked separately from `PROMPT_VERSION` on purpose: the tagging prompt is
 * unchanged by this feature, so bumping the shared constant would invalidate
 * every live URL-cache entry (`ai:tag:<version>:…`) and re-bill work that is
 * still correct. Categorize jobs stamp this version instead, and its cache
 * namespace (`ai:cat:…`) is separate anyway because the cached shape differs
 * (single placement vs. tag list).
 */
export const CATEGORIZE_PROMPT_VERSION = '2026-08-22';

export interface PromptOptions {
  maxTags: number;
  wantSummary: boolean;
  /** Optional few-shot examples to personalise output. */
  examples?: Example[];
  /**
   * Coarse topic judgement from the first pass (方案E). When present, the
   * prompt anchors each bookmark to its pre-judged topic so the second pass
   * tags with that context instead of re-deriving it from scratch.
   */
  coarseTopics?: Array<string | null>;
}

export interface Example {
  title: string;
  url: string;
  description?: string;
  tags: Array<{ name: string; reason: string }>;
  summary?: string | null;
  topic?: string;
}

/**
 * Picks the slice of the taxonomy worth spending tokens on.
 *
 * Most-used first: those are the tags the user actually organises by, and
 * matching one of them is the outcome we want most.
 *
 * Kept flat for backward compatibility; `buildTaggingPrompt` now prefers the
 * hierarchical renderer below, which also conveys parent/child granularity.
 */
export function selectVocabulary(vocab: Vocabulary, limit = VOCAB_LIMIT): string[] {
  return [...vocab.entries]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => (entry.count > 0 ? `${entry.name}(${entry.count})` : entry.name));
}

/**
 * Relevance score for ordering the vocabulary (方案D).
 *
 * Base signal is usage count. On top of it, a tag whose name appears in the
 * hostnames of the batch being classified gets a boost — those are the tags
 * most likely to be correct *for this batch*, so they should survive the
 * truncation that a large taxonomy forces.
 */
function relevanceScore(entry: VocabEntry, hosts: string[]): number {
  let score = entry.count;
  if (hosts.length > 0) {
    const key = entry.name.toLowerCase();
    for (const host of hosts) {
      if (host.includes(key) || key.includes(host.split('.')[0])) {
        // A tag that names the very host being classified is almost certainly
        // relevant to this batch, so it outranks raw usage counts.
        score += 100;
        break;
      }
    }
  }
  return score;
}

/**
 * Renders the taxonomy hierarchically (方案C).
 *
 * Instead of a flat list, tags are grouped under their parent so the model can
 * see the nesting and pick the right granularity — "前端 > React, Vue" tells it
 * that React is a kind of 前端, which a flat "前端、React、Vue" list does not.
 *
 * Top-level tags (no parent, or parent absent from the selected set) lead; each
 * is followed by its children inline. Ordering within and across groups follows
 * `relevanceScore`. The output is a list of display lines, one per top-level tag.
 */
export function selectVocabularyHierarchical(
  vocab: Vocabulary,
  limit = VOCAB_LIMIT,
  hosts: string[] = [],
): string[] {
  const entries = vocab.entries;
  if (entries.length === 0) return [];

  const byId = new Map(entries.map((e) => [e.id, e]));
  const childrenOf = new Map<string, VocabEntry[]>();
  const roots: VocabEntry[] = [];

  for (const entry of entries) {
    const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
    if (parent) {
      const list = childrenOf.get(parent.id) ?? [];
      list.push(entry);
      childrenOf.set(parent.id, list);
    } else {
      roots.push(entry);
    }
  }

  const score = (e: VocabEntry) => relevanceScore(e, hosts);
  roots.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  for (const list of childrenOf.values()) {
    list.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  }

  const label = (e: VocabEntry) => (e.count > 0 ? `${e.name}(${e.count})` : e.name);

  const lines: string[] = [];
  let used = 0;
  for (const root of roots) {
    if (used >= limit) break;
    const kids = (childrenOf.get(root.id) ?? []).slice(0, Math.max(0, limit - used - 1));
    used += 1 + kids.length;
    lines.push(
      kids.length > 0
        ? `${label(root)} > ${kids.map(label).join('、')}`
        : label(root),
    );
  }

  // Any children whose parent was cut off still deserve a chance to appear.
  if (used < limit) {
    const shown = new Set<string>();
    for (const line of lines) {
      for (const part of line.split(/[>、]/)) shown.add(part.replace(/\(\d+\)$/, '').trim());
    }
    for (const entry of entries) {
      if (used >= limit) break;
      if (shown.has(entry.name)) continue;
      const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
      if (parent && shown.has(parent.name)) continue; // already shown under parent
      lines.push(label(entry));
      shown.add(entry.name);
      used += 1;
    }
  }

  return lines;
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function renderBookmark(input: EnrichInput, index: number): string {
  const parts = [`[${index + 1}] 标题：${truncate(input.title || '(无标题)', MAX_TITLE)}`];
  parts.push(`    网址：${truncate(input.url, 200)}`);
  if (input.description) {
    parts.push(`    描述：${truncate(String(input.description), MAX_DESCRIPTION)}`);
  }
  // 方案A: the fetched page excerpt is the strongest content signal we have —
  // render it last so the model reads title/URL/description first, then the
  // actual page text that confirms or corrects them.
  if (input.pageExcerpt) {
    parts.push(`    正文摘要：${truncate(String(input.pageExcerpt), MAX_EXCERPT)}`);
  }
  return parts.join('\n');
}

/**
 * Builds the system / task preamble shared by tagging and summarisation.
 */
function basePreamble(): string {
  return [
    '你是个人书签归档助手。任务：理解网页内容，输出可长期复用的主题标签、一句话摘要和主题短语。',
    '',
    '核心原则：',
    '- 优先从「已有标签」中选择。只有确实没有合适标签时，才建议新建标签。',
    '- 标签必须具体、可复用。避免「网站」「链接」「资料」「文章」这类宽泛词。',
    '- 不要把文章标题整句当作标签。',
    '- 用中文，专有名词保留原文（React、Python、Docker、LLM）。',
    '- 每个标签 ≤ 24 字；理由 ≤ 24 字；摘要 ≤ 200 字；主题短语 ≤ 40 字。',
    '',
    '分类保护规则（P2-3）：',
    '- 同一公司、同一项目或同一业务系统的页面应归到同一分类下，不要拆散。',
    '- 尊重用户已有分类的语义：已有标签能覆盖时，不要另建近义新标签。',
    '- 同一主题的不同表述（如「前端 / Frontend / 前端开发」）应统一到已有标签的写法。',
  ].join('\n');
}

/**
 * Schema block embedded in the prompt so even providers without native JSON
 * schema support see the exact expected shape.
 */
function taggingSchema(options: { maxTags: number; wantSummary: boolean }): string {
  const tagShape = `{"name":"标签名","confidence":0.85,"reason":"不超过24字的理由","isNew":false}`;
  const resultShape = options.wantSummary
    ? `{"i":1,"tags":[${tagShape}],"summary":"一句话摘要或null","topic":"主题短语","needsReview":false}`
    : `{"i":1,"tags":[${tagShape}],"topic":"主题短语","needsReview":false}`;
  const lines = [
    '输出格式：仅输出一个 JSON 对象，不要代码块、不要解释。',
    `schema: {"results":[${resultShape}]}`,
    '',
    '字段说明：',
    '- i: 书签序号，从 1 开始，与输入顺序一致。',
    `- tags: 0-${options.maxTags} 个标签。confidence 为 0-1。isNew 为 true 表示建议新建标签。`,
  ];
  // The summary field is only documented when summarisation is on, so a run
  // that does not want summaries never asks the model to produce one (and
  // saves the tokens the model would spend on it).
  if (options.wantSummary) {
    lines.push('- summary: 一句话中文摘要；无法判断填 null。');
  }
  lines.push('- topic: 该书签所属的主题短语，如「前端框架」「机器学习论文」「设计灵感」。');
  lines.push('- needsReview: 当你对标签是否合适没有把握时填 true，即使用户未设置低置信度阈值也会进入人工确认。');
  return lines.join('\n');
}

const DEFAULT_EXAMPLES: Example[] = [
  {
    title: 'React 官方文档： Thinking in React',
    url: 'https://react.dev/learn/thinking-in-react',
    description: 'Learn how to think in React with a searchable product table example.',
    tags: [
      { name: '前端', reason: 'React 官方文档' },
      { name: '文档', reason: '官方学习资料' },
    ],
    summary: 'React 官方文档中关于如何以 React 方式思考组件拆分的教程。',
    topic: '前端框架',
  },
  {
    title: 'Fine-tuning GPT-4o: Best practices',
    url: 'https://platform.openai.com/docs/guides/fine-tuning',
    description: 'Best practices for fine-tuning OpenAI models.',
    tags: [
      { name: '人工智能', reason: 'OpenAI 微调指南' },
      { name: '教程', reason: '最佳实践说明' },
    ],
    summary: 'OpenAI 官方关于 GPT-4o 微调的实践指南。',
    topic: '大模型微调',
  },
  {
    title: 'Awesome Self-Hosted',
    url: 'https://github.com/awesome-selfhosted/awesome-selfhosted',
    description: 'A list of Free Software network services and web applications.',
    tags: [
      { name: '开源', reason: 'GitHub 资源合集' },
      { name: '工具', reason: '自托管工具列表' },
      { name: '运维', reason: '服务器部署相关' },
    ],
    summary: 'GitHub 上关于可自托管开源软件与网络服务的资源合集。',
    topic: '开源工具',
  },
];

const ANTI_EXAMPLES = [
  { bad: '一个很好用的网站', why: '过于宽泛，无法复用' },
  { bad: 'React 官方文档：Thinking in React', why: '把标题当标签' },
  { bad: '收藏', why: '动作标签，不描述主题' },
  { bad: '资料', why: '空泛，几乎所有书签都是资料' },
];

function renderExamples(examples: Example[], wantSummary: boolean): string {
  if (examples.length === 0) return '';
  const lines = ['', '参考示例：'];
  for (const ex of examples) {
    lines.push(`标题：${ex.title}`);
    lines.push(`网址：${ex.url}`);
    if (ex.description) lines.push(`描述：${ex.description}`);
    lines.push(`标签：${ex.tags.map((t) => `${t.name}（${t.reason}）`).join('、')}`);
    if (wantSummary && ex.summary !== undefined) lines.push(`摘要：${ex.summary ?? 'null'}`);
    if (ex.topic) lines.push(`主题：${ex.topic}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderAntiExamples(): string {
  return [
    '',
    '错误示例（不要输出这类标签）：',
    ...ANTI_EXAMPLES.map((ex) => `- 「${ex.bad}」→ ${ex.why}`),
  ].join('\n');
}

/**
 * Builds one prompt covering a batch of bookmarks.
 *
 * The prompt is ordered by empirical violation frequency: reuse first,
 * specificity second, anti-garbage third, schema last.
 */
export function buildTaggingPrompt(
  inputs: EnrichInput[],
  vocab: Vocabulary,
  options: PromptOptions,
): string {
  // 方案D: collect the hosts of this batch so relevance scoring can boost
  // tags that match them, keeping the most useful labels inside the budget.
  const hosts = inputs
    .map((input) => {
      try {
        return new URL(input.url).hostname.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  // 方案C: hierarchical rendering so the model sees parent/child granularity.
  const known = selectVocabularyHierarchical(vocab, VOCAB_LIMIT, hosts);
  const examples = options.examples && options.examples.length > 0 ? options.examples : DEFAULT_EXAMPLES;

  const lines: string[] = [
    basePreamble(),
    '',
    taggingSchema({ maxTags: options.maxTags, wantSummary: options.wantSummary }),
  ];

  if (known.length > 0) {
    lines.push('', '已有标签（括号内为使用次数，优先复用高频标签；「>」表示父子层级，请选择最具体的层级）：');
    lines.push(...known.map((line) => `- ${line}`));
  } else {
    lines.push('', '该用户还没有任何标签，请建立一套简洁、可复用的基础分类。');
  }

  lines.push(renderExamples(examples, options.wantSummary));
  lines.push(renderAntiExamples());

  // 方案E: when a coarse pass has already judged each bookmark's topic, anchor
  // the fine pass to it so tagging builds on that judgement.
  if (options.coarseTopics && options.coarseTopics.length === inputs.length) {
    lines.push('', '初步主题判断（供参考，可修正）：');
    inputs.forEach((_, index) => {
      const topic = options.coarseTopics?.[index];
      if (topic) lines.push(`[${index + 1}] ${topic}`);
    });
  }

  lines.push('', '待整理书签：');
  inputs.forEach((input, index) => {
    lines.push(renderBookmark(input, index));
  });

  lines.push('', '仅输出一个 JSON 对象，不要代码块、不要解释。');
  return lines.join('\n');
}

/**
 * Dedicated summarisation prompt.
 *
 * Keeping summary generation separate lets us tune it for conciseness and
 *体裁 detection without polluting the tagging prompt.
 */
export function buildSummarizationPrompt(input: EnrichInput): string {
  return [
    basePreamble(),
    '',
    '任务：为下面这条书签生成一句话中文摘要和一个主题短语。',
    '输出格式：{"summary":"一句话摘要或null","topic":"主题短语"}',
    '- summary：一句话概括核心内容，不要复述标题；信息不足则 null。',
    '- topic：该书签的主题短语，如「前端框架」「机器学习论文」「设计灵感」。',
    '',
    '待整理书签：',
    renderBookmark(input, 0),
    '',
    '仅输出一个 JSON 对象，不要代码块、不要解释。',
  ].join('\n');
}

/**
 * Coarse-pass prompt (方案E, first half).
 *
 * Asks only for a one-line topic judgement per bookmark — no tags, no summary.
 * The output is tiny (one short string per bookmark), so this pass is cheap;
 * its value is giving the fine pass a settled "what is this page about"
 * judgement to tag against, instead of re-deriving it while also choosing tags.
 */
export function buildCoarsePrompt(inputs: EnrichInput[]): string {
  const lines: string[] = [
    '你是个人书签归档助手。任务：快速判断每个网页属于什么主题领域。',
    '只输出主题判断，不要输出标签、摘要或其他内容。',
    '',
    '输出格式：仅输出一个 JSON 对象，不要代码块、不要解释。',
    'schema: {"results":[{"i":1,"topic":"主题领域短语"}]}',
    '- i: 书签序号，从 1 开始，与输入顺序一致。',
    '- topic: 一个简短的主题领域短语，如「前端框架」「机器学习论文」「设计灵感」「运维工具」。',
    '',
    '待判断书签：',
  ];
  inputs.forEach((input, index) => {
    lines.push(renderBookmark(input, index));
  });
  lines.push('', '仅输出一个 JSON 对象，不要代码块、不要解释。');
  return lines.join('\n');
}

/**
 * Parses the coarse-pass response into per-bookmark topics.
 *
 * Returns an array aligned to the batch (null where the model gave no answer),
 * matching the shape `buildTaggingPrompt` expects for `coarseTopics`.
 */
export function parseCoarseResponse(raw: string | null, batchSize: number): Array<string | null> {
  const topics: Array<string | null> = new Array(batchSize).fill(null);
  if (!raw) return topics;

  const parsed = extractJsonValue(raw);
  if (parsed === null) return topics;

  // Accept either the documented {results:[...]} shape or a bare array-root
  // ([{...},{...}]) — some models emit the latter and the old parser dropped it.
  const results = Array.isArray(parsed)
    ? parsed
    : (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return topics;

  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { i?: unknown; topic?: unknown };
    const rawIndex = Number(row.i);
    if (!Number.isFinite(rawIndex)) continue;
    const index = Math.trunc(rawIndex) - 1;
    if (index < 0 || index >= batchSize) continue;
    if (typeof row.topic === 'string' && row.topic.trim()) {
      topics[index] = row.topic.trim().slice(0, MAX_TOPIC_LENGTH);
    }
  }

  return topics;
}

export interface ParsedTag {
  name: string;
  confidence: number;
  reason: string;
  isNew: boolean;
}

/* ------------------------------------------------------------------ *
 * Categorize mode (CategorySync P1, C1-1 / C1-2 / C1-3)
 *
 * Tagging asks "which labels fit?" and happily returns several; categorizing
 * asks "which single folder does this belong in?" and returns exactly one
 * placement. The two prompts share the robust extraction layer but diverge
 * everywhere else: the schema, the few-shot examples and the rules all push
 * the model toward a unique, tree-anchored decision instead of a tag cloud.
 * ------------------------------------------------------------------ */

export interface CategorizePromptOptions {
  /**
   * Optional few-shot examples. When absent, `DEFAULT_CATEGORIZE_EXAMPLES`
   * are used so the model always sees the single-placement shape.
   */
  examples?: CategorizeExample[];
}

export interface CategorizeExample {
  title: string;
  url: string;
  description?: string;
  category: string;
  subcategory?: string | null;
  reason: string;
}

/** One bookmark's single placement, as the model reports it. */
export interface ParsedCategory {
  /** Top-level category (一级分类). */
  category: string;
  /** Second-level category (二级分类); null when the top level is enough. */
  subcategory: string | null;
  confidence: number;
  reason: string;
  /** True when the model could not reuse the existing tree and proposes a new node. */
  isNew: boolean;
  needsReview: boolean;
}

export interface ParsedCategorizeItem {
  /** Zero-based index back into the batch. */
  index: number;
  /** Null when the model returned no usable placement for this bookmark. */
  category: ParsedCategory | null;
}

const DEFAULT_CATEGORIZE_EXAMPLES: CategorizeExample[] = [
  {
    title: 'React 官方文档：Thinking in React',
    url: 'https://react.dev/learn/thinking-in-react',
    description: 'Learn how to think in React with a searchable product table example.',
    category: '开发技术',
    subcategory: '前端开发',
    reason: 'React 官方教程',
  },
  {
    title: 'Figma — 在线协作设计工具',
    url: 'https://www.figma.com/',
    description: 'Figma is the leading collaborative design tool.',
    category: '在线工具',
    subcategory: null,
    reason: '在线设计工具',
  },
  {
    title: '深度学习论文：Attention Is All You Need',
    url: 'https://arxiv.org/abs/1706.03762',
    description: 'The original Transformer paper.',
    category: '人工智能',
    subcategory: '论文',
    reason: 'Transformer 论文',
  },
];

function renderCategorizeExamples(examples: CategorizeExample[]): string {
  if (examples.length === 0) return '';
  const lines = ['', '参考示例：'];
  for (const ex of examples) {
    lines.push(`标题：${ex.title}`);
    lines.push(`网址：${ex.url}`);
    if (ex.description) lines.push(`描述：${ex.description}`);
    const path = ex.subcategory ? `${ex.category} > ${ex.subcategory}` : ex.category;
    lines.push(`分类：${path}（${ex.reason}）`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Builds one categorize prompt covering a batch of bookmarks (C1-1/C1-2).
 *
 * Differences from `buildTaggingPrompt`, each deliberate:
 *  - The task is *placement*, not labelling: exactly one `{category,
 *    subcategory}` per bookmark, never a list (fixes G1).
 *  - The decision must come from page content — title + URL + description +
 *    fetched excerpt — not from whatever tags happen to exist (fixes G2).
 *  - The existing tree is presented as the *target* structure; new nodes are
 *    allowed but flagged `isNew` so they enter review instead of silently
 *    inflating the taxonomy (C1-3).
 */
export function buildCategorizePrompt(
  inputs: EnrichInput[],
  vocab: Vocabulary,
  options: CategorizePromptOptions = {},
): string {
  const hosts = inputs
    .map((input) => {
      try {
        return new URL(input.url).hostname.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  const known = selectVocabularyHierarchical(vocab, VOCAB_LIMIT, hosts);
  const examples =
    options.examples && options.examples.length > 0 ? options.examples : DEFAULT_CATEGORIZE_EXAMPLES;

  const lines: string[] = [
    [
      '你是个人书签归档助手。任务：理解每个网页的内容，为每条书签指定唯一的分类归属。',
      '',
      '这不是打标签：每条书签有且只有一个归属，就像把它放进书架上的一个文件夹。',
      '',
      '核心原则：',
      '- 依据页面内容（标题、网址、描述、正文摘要）判断归属，而不是依据书签上已有的标签。',
      '- 优先从「已有分类树」中选择节点；确无合适节点时才建议新分类（isNew 填 true）。',
      '- 一级分类要稳定、宽泛、可长期复用（如「开发技术」「在线工具」「人工智能」）；二级子类更具体（如「前端开发」「论文」）。',
      '- 内容只够判断一级时，subcategory 填 null，不要硬造二级。',
      '- 同一公司、同一项目或同一业务系统的页面应归到同一分类下，不要拆散。',
      '- 用中文，专有名词保留原文（React、Python、Docker、LLM）。',
      '- 分类名 ≤ 24 字；理由 ≤ 24 字。',
    ].join('\n'),
    '',
    [
      '输出格式：仅输出一个 JSON 对象，不要代码块、不要解释。',
      'schema: {"results":[{"i":1,"category":"一级分类","subcategory":"二级分类或null","confidence":0.85,"reason":"不超过24字的理由","isNew":false,"needsReview":false}]}',
      '',
      '字段说明：',
      '- i: 书签序号，从 1 开始，与输入顺序一致。',
      '- category: 一级分类，必填。',
      '- subcategory: 二级分类；无法判断或不需要时填 null。',
      '- confidence: 0-1，对归属有多大把握。内容信息不足时如实给低分。',
      '- reason: 不超过 24 字的归属理由。',
      '- isNew: 该分类节点不在「已有分类树」中、需要新建时填 true。',
      '- needsReview: 对归属没有把握时填 true，进入人工确认。',
    ].join('\n'),
  ];

  if (known.length > 0) {
    lines.push('', '已有分类树（括号内为书签数，「>」表示父子层级；请优先归入已有节点，选择最具体的层级）：');
    lines.push(...known.map((line) => `- ${line}`));
  } else {
    lines.push('', '该用户还没有任何分类，请建立一套简洁（≤10 个一级分类）、可长期复用的分类体系。');
  }

  lines.push(renderCategorizeExamples(examples));

  lines.push('', '待分类书签：');
  inputs.forEach((input, index) => {
    lines.push(renderBookmark(input, index));
  });

  lines.push('', '仅输出一个 JSON 对象，不要代码块、不要解释。');
  return lines.join('\n');
}

/**
 * Normalises one model row into a `ParsedCategory`.
 *
 * Tolerates two common shape variants besides the documented one:
 *  - `path: ["开发技术", "前端开发"]` — models that read the tree as a path;
 *  - `category: "开发技术 > 前端开发"` — models that fold the path into one
 *    string. Both are split into (category, subcategory) so downstream code
 *    sees one shape only.
 */
function parseCategoryRow(row: Record<string, unknown>): ParsedCategory | null {
  let category = '';
  let subcategory: string | null = null;

  const rawPath = row.path;
  if (Array.isArray(rawPath)) {
    // Path-array variant: first element is the top level, last is the deepest.
    const parts = rawPath
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim().slice(0, MAX_TAG_LENGTH));
    if (parts.length > 0) {
      category = parts[0];
      // The tree is capped at three levels; anything deeper collapses onto the
      // second level so the placement stays representable.
      subcategory = parts.length > 1 ? parts.slice(1).join(' > ').slice(0, MAX_TAG_LENGTH) : null;
    }
  }

  if (!category && typeof row.category === 'string') {
    const raw = row.category.trim();
    if (raw.includes('>')) {
      // Folded-path variant: "开发技术 > 前端开发".
      const parts = raw
        .split('>')
        .map((p) => p.trim())
        .filter(Boolean);
      category = (parts[0] ?? '').slice(0, MAX_TAG_LENGTH);
      subcategory =
        parts.length > 1 ? parts.slice(1).join(' > ').slice(0, MAX_TAG_LENGTH) : null;
    } else {
      category = raw.slice(0, MAX_TAG_LENGTH);
    }
  }

  if (!category) return null;

  if (subcategory === null && typeof row.subcategory === 'string' && row.subcategory.trim()) {
    subcategory = row.subcategory.trim().slice(0, MAX_TAG_LENGTH);
  }

  const confidenceRaw = Number(row.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.6;

  const reason =
    typeof row.reason === 'string' && row.reason.trim()
      ? row.reason.trim().slice(0, MAX_REASON_LENGTH)
      : '模型分类';

  return {
    category,
    subcategory,
    confidence,
    reason,
    isNew: row.isNew === true,
    needsReview: row.needsReview === true,
  };
}

/**
 * Parses a categorize batch response (C1-1).
 *
 * Shares the robust `extractJsonValue` layer with the tagging parser: fences,
 * prose, full-width brackets and trailing commas are all tolerated. Malformed
 * rows degrade to `category: null` for that bookmark — which the engine counts
 * as uncategorized (C1-7) rather than failing the whole batch.
 */
export function parseCategorizeResponse(raw: string | null, batchSize: number): ParsedCategorizeItem[] {
  if (!raw) return [];

  const parsed = extractJsonValue(raw);
  if (parsed === null) return [];

  const results = Array.isArray(parsed)
    ? parsed
    : (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  const out: ParsedCategorizeItem[] = [];

  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { i?: unknown } & Record<string, unknown>;

    const rawIndex = Number(row.i);
    if (!Number.isFinite(rawIndex)) continue;
    const index = Math.trunc(rawIndex) - 1;
    if (index < 0 || index >= batchSize) continue;

    out.push({ index, category: parseCategoryRow(row) });
  }

  return out;
}

export interface ParsedItem {
  /** Zero-based index back into the batch. */
  index: number;
  tags: ParsedTag[];
  summary: string | null;
  topic: string | null;
  needsReview: boolean;
}

function parseTag(raw: unknown): ParsedTag | null {
  // Tolerate a bare string array — a common shortcut in model output.
  if (typeof raw === 'string') {
    const name = raw.trim().slice(0, MAX_TAG_LENGTH);
    return name ? { name, confidence: 0.6, reason: '模型建议', isNew: true } : null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const tag = raw as { name?: unknown; confidence?: unknown; reason?: unknown; isNew?: unknown };
  const name = typeof tag.name === 'string' ? tag.name.trim().slice(0, MAX_TAG_LENGTH) : '';
  if (!name) return null;

  const confidenceRaw = Number(tag.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.6;

  const reason =
    typeof tag.reason === 'string' && tag.reason.trim()
      ? tag.reason.trim().slice(0, MAX_REASON_LENGTH)
      : '模型建议';

  const isNew = tag.isNew === true;

  return { name, confidence, reason, isNew };
}

/**
 * Slices the first balanced JSON value (object or array root) out of arbitrary
 * model output.
 *
 * Walks the string tracking string/escape state so brackets inside a string
 * value (e.g. a URL with `{`) are not mistaken for structure. Returns null when
 * no balanced value is found.
 */
function sliceBalancedJson(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extracts a JSON value (object or array root) from arbitrary model output.
 *
 * Tolerates the failure modes that silently dropped a whole batch under the old
 * `indexOf('{')` approach:
 *  - **array-root** responses (`[{…},{…}]`) — the old code sliced `{…},{…}`
 *    without the surrounding brackets and parsed as `[]`.
 *  - markdown fences (` ```json … ``` `) and pre/post prose.
 *  - full-width brackets (`［］｛｝`) and full-width colon (`：`) some Chinese
 *    models emit.
 *  - trailing commas before `}` / `]` (soft repair).
 *
 * Returns `null` when nothing usable is present; callers degrade gracefully.
 */
export function extractJsonValue(raw: string | null): unknown {
  if (!raw) return null;
  const normalized = String(raw)
    .replace(/^\uFEFF/, '')
    .replace(/[\u00A0\u3000\u200B]/g, ' ')
    .replace(/［/g, '[')
    .replace(/］/g, ']')
    .replace(/｛/g, '{')
    .replace(/｝/g, '}')
    .replace(/：/g, ':')
    .trim();
  if (!normalized) return null;

  const candidates: string[] = [];
  // Fenced blocks first — the most explicit intent.
  for (const m of normalized.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
    if (m[1]?.trim()) candidates.push(m[1].trim());
  }
  // Then the whole string with any leading prose stripped up to the first bracket.
  candidates.push(normalized.replace(/^[\s\S]*?(?=[{[])/, ''));

  for (const candidate of candidates) {
    const balanced = sliceBalancedJson(candidate);
    if (!balanced) continue;
    const repaired = balanced.replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(repaired);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Parses a batch response.
 *
 * Models wrap JSON in fences and prepend apologies despite instructions, so we
 * pull the first balanced JSON value (object or array root) rather than trusting
 * the whole string. Anything malformed degrades to "no suggestions for that
 * bookmark" — never an exception, because one bad response must not fail a
 * 500-bookmark job.
 */
export function parseTaggingResponse(raw: string | null, batchSize: number): ParsedItem[] {
  if (!raw) return [];

  const parsed = extractJsonValue(raw);
  if (parsed === null) return [];

  // Accept either the documented {results:[...]} shape or a bare array-root
  // ([{...},{...}]) — some models emit the latter and the old parser dropped it.
  const results = Array.isArray(parsed)
    ? parsed
    : (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  const out: ParsedItem[] = [];

  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as {
      i?: unknown;
      tags?: unknown;
      summary?: unknown;
      topic?: unknown;
      needsReview?: unknown;
    };

    const rawIndex = Number(row.i);
    if (!Number.isFinite(rawIndex)) continue;
    const index = Math.trunc(rawIndex) - 1;
    if (index < 0 || index >= batchSize) continue;

    const tags: ParsedTag[] = [];
    if (Array.isArray(row.tags)) {
      for (const item of row.tags) {
        const tag = parseTag(item);
        if (tag) tags.push(tag);
      }
    }

    const summary =
      typeof row.summary === 'string' && row.summary.trim()
        ? row.summary.trim().slice(0, MAX_SUMMARY_LENGTH)
        : null;

    const topic =
      typeof row.topic === 'string' && row.topic.trim()
        ? row.topic.trim().slice(0, MAX_TOPIC_LENGTH)
        : null;

    const needsReview = row.needsReview === true;

    out.push({ index, tags, summary, topic, needsReview });
  }

  return out;
}

/**
 * Parses the dedicated summarisation response.
 */
export function parseSummarizationResponse(raw: string | null): {
  summary: string | null;
  topic: string | null;
} {
  if (!raw) return { summary: null, topic: null };

  const parsed = extractJsonValue(raw);
  if (parsed === null) return { summary: null, topic: null };

  if (!parsed || typeof parsed !== 'object') return { summary: null, topic: null };
  const row = parsed as { summary?: unknown; topic?: unknown };

  const summary =
    typeof row.summary === 'string' && row.summary.trim()
      ? row.summary.trim().slice(0, MAX_SUMMARY_LENGTH)
      : null;

  const topic =
    typeof row.topic === 'string' && row.topic.trim()
      ? row.topic.trim().slice(0, MAX_TOPIC_LENGTH)
      : null;

  return { summary, topic };
}

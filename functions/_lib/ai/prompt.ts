import type { EnrichInput, Vocabulary } from './types';
import type { RawCandidate } from './heuristics';

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

/** How many existing tags to show. Enough to be representative, small enough to stay cheap. */
const VOCAB_LIMIT = 60;

/** Bookmarks per model request. */
export const BATCH_SIZE = 10;

const MAX_TITLE = 160;
const MAX_DESCRIPTION = 400;

export const MAX_TAG_LENGTH = 24;
export const MAX_SUMMARY_LENGTH = 200;
export const MAX_TOPIC_LENGTH = 40;
export const MAX_REASON_LENGTH = 24;

export interface PromptOptions {
  maxTags: number;
  wantSummary: boolean;
  /** Local candidates offered to the model as hints, keyed by bookmark index. */
  hints?: Map<number, RawCandidate[]>;
  /** Optional few-shot examples to personalise output. */
  examples?: Example[];
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
 */
export function selectVocabulary(vocab: Vocabulary, limit = VOCAB_LIMIT): string[] {
  return [...vocab.entries]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => (entry.count > 0 ? `${entry.name}(${entry.count})` : entry.name));
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function renderBookmark(input: EnrichInput, index: number, hints?: RawCandidate[]): string {
  const parts = [`[${index + 1}] 标题：${truncate(input.title || '(无标题)', MAX_TITLE)}`];
  parts.push(`    网址：${truncate(input.url, 200)}`);
  if (input.description) {
    parts.push(`    描述：${truncate(String(input.description), MAX_DESCRIPTION)}`);
  }
  if (hints && hints.length > 0) {
    // Local signals are offered as a hint, not an instruction: the model is
    // free to reject them, and disagreement is itself informative.
    parts.push(`    本地线索（仅供参考，可忽略）：${hints.map((h) => h.name).join('、')}`);
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
  return [
    '输出格式：仅输出一个 JSON 对象，不要代码块、不要解释。',
    `schema: {"results":[${resultShape}]}`,
    '',
    '字段说明：',
    '- i: 书签序号，从 1 开始，与输入顺序一致。',
    `- tags: 0-${options.maxTags} 个标签。confidence 为 0-1。isNew 为 true 表示建议新建标签。`,
    '- summary: 一句话中文摘要；无法判断填 null。',
    '- topic: 该书签所属的主题短语，如「前端框架」「机器学习论文」「设计灵感」。',
    '- needsReview: 当你对标签是否合适没有把握时填 true，即使用户未设置低置信度阈值也会进入人工确认。',
  ].join('\n');
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
  const known = selectVocabulary(vocab);
  const examples = options.examples && options.examples.length > 0 ? options.examples : DEFAULT_EXAMPLES;

  const lines: string[] = [
    basePreamble(),
    '',
    taggingSchema({ maxTags: options.maxTags, wantSummary: options.wantSummary }),
  ];

  if (known.length > 0) {
    lines.push('', '已有标签（括号内为使用次数，优先复用高频标签）：', known.join('、'));
  } else {
    lines.push('', '该用户还没有任何标签，请建立一套简洁、可复用的基础分类。');
  }

  lines.push(renderExamples(examples, options.wantSummary));
  lines.push(renderAntiExamples());

  lines.push('', '待整理书签：');
  inputs.forEach((input, index) => {
    lines.push(renderBookmark(input, index, options.hints?.get(index)));
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

export interface ParsedTag {
  name: string;
  confidence: number;
  reason: string;
  isNew: boolean;
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
 * Parses a batch response.
 *
 * Models wrap JSON in fences and prepend apologies despite instructions, so we
 * take the outermost balanced object rather than trusting the whole string.
 * Anything malformed degrades to "no suggestions for that bookmark" — never an
 * exception, because one bad response must not fail a 500-bookmark job.
 */
export function parseTaggingResponse(raw: string | null, batchSize: number): ParsedItem[] {
  if (!raw) return [];

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }

  const results = (parsed as { results?: unknown }).results;
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

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { summary: null, topic: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { summary: null, topic: null };
  }

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

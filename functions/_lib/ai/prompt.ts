import type { EnrichInput, Vocabulary } from './types';
import type { RawCandidate } from './heuristics';

/**
 * Prompt construction and response parsing.
 *
 * The single biggest accuracy win in this refactor lives here: **the model is
 * shown the user's existing tags and told to prefer them.**
 *
 * The previous prompt asked "what is this page about?" with no context, so the
 * model invented a fresh vocabulary on every call. Across a library that
 * produces 前端 / Frontend / 前端开发 for one concept — technically correct
 * answers that add up to an unusable tag system. Handing over the current
 * taxonomy converts the task from *generation* (open-ended, unstable) into
 * *classification against a known label set* (constrained, repeatable), which
 * is both easier for the model and far more useful downstream.
 *
 * Batching is the second lever. One request carries many bookmarks, so
 * organising 500 bookmarks is tens of calls rather than 500 — the difference
 * between a feature someone runs on their whole library and one they run twice
 * and give up on.
 */

/** How many existing tags to show. Enough to be representative, small enough to stay cheap. */
const VOCAB_LIMIT = 60;

/** Bookmarks per model request. */
export const BATCH_SIZE = 10;

const MAX_TITLE = 160;
const MAX_DESCRIPTION = 400;

export const MAX_TAG_LENGTH = 24;
export const MAX_SUMMARY_LENGTH = 300;

export interface PromptOptions {
  maxTags: number;
  wantSummary: boolean;
  /** Local candidates offered to the model as hints, keyed by bookmark index. */
  hints?: Map<number, RawCandidate[]>;
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

/**
 * Builds one prompt covering a batch of bookmarks.
 *
 * The rules are ordered by how often they are violated in practice: reuse
 * first, then specificity, then the anti-garbage rules.
 */
export function buildTaggingPrompt(
  inputs: EnrichInput[],
  vocab: Vocabulary,
  options: PromptOptions,
): string {
  const known = selectVocabulary(vocab);

  const lines: string[] = [
    '你是书签整理助手。为每条书签挑选主题标签，用于长期归档检索。',
    '',
    '规则：',
    `1. 【最重要】优先复用「已有标签」中的词。只有确实没有任何合适的已有标签时，才创造新标签。`,
    `2. 每条书签最多 ${options.maxTags} 个标签，宁少勿滥；只有一个贴切标签时就只给一个。`,
    '3. 标签要能复用：避免「网站」「链接」「资料」这类过于宽泛的词，也避免把文章标题当标签。',
    `4. 用中文，专有名词保留原文（React、Python、Docker）。每个标签不超过 ${MAX_TAG_LENGTH} 字。`,
    '5. 每个标签给出 confidence（0-1，表示你有多确定）和 reason（不超过 12 字的理由）。',
    '6. 信息不足以判断时，返回空数组，不要猜。',
  ];

  if (options.wantSummary) {
    lines.push(`7. 同时给出 summary：一句话中文摘要，不超过 ${MAX_SUMMARY_LENGTH} 字；无法判断则为 null。`);
  }

  if (known.length > 0) {
    lines.push(
      '',
      '已有标签（括号内为使用次数，优先复用高频标签）：',
      known.join('、'),
    );
  } else {
    lines.push('', '该用户还没有任何标签，请建立一套简洁、可复用的基础分类。');
  }

  lines.push('', '待整理书签：');

  inputs.forEach((input, index) => {
    const parts = [`[${index + 1}] 标题：${truncate(input.title || '(无标题)', MAX_TITLE)}`];
    parts.push(`    网址：${truncate(input.url, 200)}`);
    if (input.description) {
      parts.push(`    描述：${truncate(String(input.description), MAX_DESCRIPTION)}`);
    }
    const hint = options.hints?.get(index);
    if (hint && hint.length > 0) {
      // Local signals are offered as a hint, not an instruction: the model is
      // free to reject them, and disagreement is itself informative.
      parts.push(`    本地线索（仅供参考，可忽略）：${hint.map((h) => h.name).join('、')}`);
    }
    lines.push(parts.join('\n'));
  });

  lines.push(
    '',
    '仅输出一个 JSON 对象，不要代码块、不要解释：',
    options.wantSummary
      ? '{"results":[{"i":1,"tags":[{"name":"前端","confidence":0.9,"reason":"React 官方文档"}],"summary":"…"}]}'
      : '{"results":[{"i":1,"tags":[{"name":"前端","confidence":0.9,"reason":"React 官方文档"}]}]}',
  );

  return lines.join('\n');
}

export interface ParsedItem {
  /** Zero-based index back into the batch. */
  index: number;
  tags: Array<{ name: string; confidence: number; reason: string }>;
  summary: string | null;
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
    const row = entry as { i?: unknown; tags?: unknown; summary?: unknown };

    const rawIndex = Number(row.i);
    if (!Number.isFinite(rawIndex)) continue;
    const index = Math.trunc(rawIndex) - 1;
    if (index < 0 || index >= batchSize) continue;

    const tags: ParsedItem['tags'] = [];
    if (Array.isArray(row.tags)) {
      for (const item of row.tags) {
        // Tolerate a bare string array — a common shortcut in model output.
        if (typeof item === 'string') {
          const name = item.trim().slice(0, MAX_TAG_LENGTH);
          if (name) tags.push({ name, confidence: 0.6, reason: '模型建议' });
          continue;
        }
        if (!item || typeof item !== 'object') continue;
        const tag = item as { name?: unknown; confidence?: unknown; reason?: unknown };
        const name = typeof tag.name === 'string' ? tag.name.trim().slice(0, MAX_TAG_LENGTH) : '';
        if (!name) continue;
        const confidenceRaw = Number(tag.confidence);
        const confidence = Number.isFinite(confidenceRaw)
          ? Math.min(1, Math.max(0, confidenceRaw))
          : 0.6;
        const reason =
          typeof tag.reason === 'string' && tag.reason.trim()
            ? tag.reason.trim().slice(0, 40)
            : '模型建议';
        tags.push({ name, confidence, reason });
      }
    }

    const summary =
      typeof row.summary === 'string' && row.summary.trim()
        ? row.summary.trim().slice(0, MAX_SUMMARY_LENGTH)
        : null;

    out.push({ index, tags, summary });
  }

  return out;
}

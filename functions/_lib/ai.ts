import type { AiProvider } from '../../shared/types';
import type { Env } from './env';
import { decryptField } from './crypto';
import { ensureTags } from './db';
import { createLogger } from './logger';

/**
 * AI enrichment: auto-summary and suggested tags for a freshly saved bookmark.
 *
 * Three constraints shape this module:
 *
 *  1. **It must never break saving a bookmark.** The bookmark is already
 *     committed before enrichment starts; every failure path here is swallowed
 *     and logged. A dead provider must not turn into a failed save.
 *  2. **It must never block the response.** The call runs in `waitUntil`, so
 *     the user gets their 201 immediately and the summary appears on the next
 *     read. Waiting several seconds on a model would be a worse product than
 *     showing the summary a moment later.
 *  3. **It must never overwrite the user.** Tags the user typed win; the model
 *     only adds. An existing summary is left alone.
 *
 * The request/response shaping per provider is kept as pure functions so the
 * awkward part — three different JSON envelopes — is unit-testable without a
 * network or an API key.
 */

export interface AiConfig {
  provider: AiProvider;
  baseUrl: string | null;
  model: string;
  apiKey: string;
  autoTag: boolean;
  autoSummarize: boolean;
}

export interface EnrichInput {
  url: string;
  title: string;
  description?: string | null;
}

export interface Enrichment {
  summary: string | null;
  tags: string[];
}

/** Hard ceilings, applied to model output before it reaches the database. */
export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 24;
export const MAX_SUMMARY_LENGTH = 300;
const REQUEST_TIMEOUT_MS = 20_000;

const DEFAULT_ENDPOINTS: Record<Exclude<AiProvider, 'none' | 'custom'>, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/**
 * Reads the stored configuration and decides whether enrichment can run.
 *
 * Returns null — rather than throwing — whenever the feature is off, half
 * configured, or missing a key. "Not configured" is the normal case, not an
 * error worth surfacing.
 */
export async function loadAiConfig(env: Env, userId: string): Promise<AiConfig | null> {
  const row = await env.DB.prepare(`SELECT * FROM ai_settings WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>();

  if (!row || row.enabled !== 1) return null;

  const provider = (row.provider as AiProvider) ?? 'none';
  if (provider === 'none') return null;

  const autoTag = row.auto_tag === 1;
  const autoSummarize = row.auto_summarize === 1;
  if (!autoTag && !autoSummarize) return null;

  const model = typeof row.model === 'string' ? row.model.trim() : '';
  if (!model) return null;

  const apiKey = await decryptField((row.api_key_encrypted as string | null) ?? null, env);
  if (!apiKey) return null;

  return {
    provider,
    baseUrl: (row.base_url as string | null) ?? null,
    model,
    apiKey,
    autoTag,
    autoSummarize,
  };
}

export function resolveEndpoint(config: AiConfig): string | null {
  const base = config.baseUrl?.trim().replace(/\/+$/, '');
  if (config.provider === 'custom') return base || null;
  return base || DEFAULT_ENDPOINTS[config.provider as keyof typeof DEFAULT_ENDPOINTS] || null;
}

export function buildPrompt(input: EnrichInput, config: AiConfig): string {
  const wants: string[] = [];
  if (config.autoSummarize) wants.push(`"summary": 一句话中文摘要，不超过 ${MAX_SUMMARY_LENGTH} 字`);
  if (config.autoTag) wants.push(`"tags": 最多 ${MAX_TAGS} 个主题标签的数组，每个不超过 ${MAX_TAG_LENGTH} 字`);

  return [
    '你在为一个书签管理器整理条目。仅输出一个 JSON 对象，不要代码块，不要解释。',
    `需要的字段：{ ${wants.join(', ')} }。`,
    '若信息不足以判断，对应字段返回 null 或空数组。',
    '',
    `标题：${input.title}`,
    `网址：${input.url}`,
    input.description ? `描述：${String(input.description).slice(0, 1000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Shapes one prompt into whatever envelope the selected provider expects. */
export function buildProviderRequest(config: AiConfig, prompt: string): ProviderRequest | null {
  const endpoint = resolveEndpoint(config);
  if (!endpoint) return null;

  switch (config.provider) {
    case 'anthropic':
      return {
        url: `${endpoint}/messages`,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: {
          model: config.model,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        },
      };
    case 'gemini':
      return {
        url: `${endpoint}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
        headers: { 'content-type': 'application/json' },
        body: { contents: [{ parts: [{ text: prompt }] }] },
      };
    // OpenAI's chat-completions shape is the de-facto standard, so "custom"
    // (LM Studio, Ollama's OpenAI bridge, OpenRouter, a corporate gateway…)
    // rides the same path.
    case 'openai':
    case 'custom':
      return {
        url: `${endpoint}/chat/completions`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: {
          model: config.model,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        },
      };
    default:
      return null;
  }
}

/** Pulls the assistant's text out of each provider's response envelope. */
export function extractText(provider: AiProvider, payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null;
  if (!p) return null;

  if (provider === 'anthropic') {
    const content = p.content as Array<{ text?: string }> | undefined;
    return content?.map((c) => c.text ?? '').join('') || null;
  }
  if (provider === 'gemini') {
    const candidates = p.candidates as
      | Array<{ content?: { parts?: Array<{ text?: string }> } }>
      | undefined;
    return candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('') || null;
  }
  const choices = p.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content ?? null;
}

/**
 * Parses and sanitises model output.
 *
 * Models routinely wrap JSON in ``` fences or prepend a sentence despite being
 * told not to, so the first balanced object in the text is used rather than
 * trusting the whole string. Anything unparseable yields an empty enrichment,
 * never an exception.
 */
export function parseEnrichment(raw: string | null): Enrichment {
  const empty: Enrichment = { summary: null, tags: [] };
  if (!raw) return empty;

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return empty;
  }

  const obj = parsed as { summary?: unknown; tags?: unknown };

  const summary =
    typeof obj.summary === 'string' && obj.summary.trim()
      ? obj.summary.trim().slice(0, MAX_SUMMARY_LENGTH)
      : null;

  const seen = new Set<string>();
  const tags: string[] = [];
  if (Array.isArray(obj.tags)) {
    for (const entry of obj.tags) {
      if (typeof entry !== 'string') continue;
      const tag = entry.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= MAX_TAGS) break;
    }
  }

  return { summary, tags };
}

/** Calls the provider. Returns null on any failure; never throws. */
export async function requestEnrichment(
  config: AiConfig,
  input: EnrichInput,
  fetchImpl: typeof fetch = fetch,
): Promise<Enrichment | null> {
  const req = buildProviderRequest(config, buildPrompt(input, config));
  if (!req) return null;

  const response = await fetchImpl(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) return null;
  const payload = (await response.json()) as unknown;
  return parseEnrichment(extractText(config.provider, payload));
}

/**
 * Writes enrichment back, without stepping on anything the user set.
 *
 * `ai_summary` is only filled when still empty, and tags are inserted with
 * `OR IGNORE` so a tag the user already applied is untouched.
 */
export async function applyEnrichment(
  env: Env,
  userId: string,
  bookmarkId: string,
  result: Enrichment,
): Promise<void> {
  if (result.summary) {
    await env.DB.prepare(
      `UPDATE bookmarks SET ai_summary = ?
        WHERE id = ? AND user_id = ? AND (ai_summary IS NULL OR ai_summary = '')`,
    )
      .bind(result.summary, bookmarkId, userId)
      .run();
  }

  if (result.tags.length > 0) {
    const { ids } = await ensureTags(env, userId, result.tags);
    for (const tagId of ids) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)`,
      )
        .bind(bookmarkId, tagId)
        .run();
    }
  }
}

/**
 * Entry point for route handlers. Safe to hand straight to `ctx.waitUntil`.
 *
 * Every branch resolves; the caller does not need a try/catch, and a provider
 * outage shows up as a log line rather than a user-visible error.
 */
export async function enrichBookmark(
  env: Env,
  userId: string,
  bookmarkId: string,
  input: EnrichInput,
): Promise<void> {
  const log = createLogger(env);
  try {
    const config = await loadAiConfig(env, userId);
    if (!config) return;

    const result = await requestEnrichment(config, input);
    if (!result || (!result.summary && result.tags.length === 0)) {
      log.info('ai.enrich.empty', { userId, provider: config.provider });
      return;
    }

    await applyEnrichment(env, userId, bookmarkId, result);
    log.info('ai.enrich', {
      userId,
      provider: config.provider,
      tagged: result.tags.length,
      summarized: Boolean(result.summary),
    });
  } catch (error) {
    log.warn('ai.enrich.failed', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

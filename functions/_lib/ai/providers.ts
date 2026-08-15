import type { AiProvider } from '../../../shared/types';
import type { AiConfig } from './types';

/**
 * Provider plumbing: three JSON envelopes behind one function.
 *
 * Kept as pure request builders and response unpackers so the awkward part is
 * unit-testable without a network or an API key. Only `callProvider` touches
 * fetch.
 *
 * Changed in the tagging refactor:
 *  - `max_tokens` raised for batch responses (ten bookmarks of tags no longer
 *    fit in 512 tokens, and a truncated response used to parse as "no tags",
 *    silently dropping most of a batch).
 *  - Native JSON mode requested where the provider supports it, which removes
 *    the most common parse failure. `custom` is deliberately excluded: local
 *    runtimes and gateways often reject the unknown field outright.
 */

export const DEFAULT_ENDPOINTS: Record<Exclude<AiProvider, 'none' | 'custom'>, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/**
 * Batch responses are long; too small a ceiling truncates them into nothing.
 * Exported so the cost estimator (estimate.ts) can cap its per-batch output
 * forecast at exactly what the provider request will allow.
 */
export const MAX_OUTPUT_TOKENS = 2048;

/**
 * Model request deadline.
 *
 * Must stay *shorter* than the client's chunk deadline (90s in
 * `useOrganizeRun`) so the server fails first and returns a useful error
 * instead of the client aborting mid-flight and showing a generic timeout.
 * 25s is generous for a 10-bookmark batch while keeping total chunk time
 * (2 batches + D1 writes) well under a minute.
 */
const REQUEST_TIMEOUT_MS = 25_000;

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function resolveEndpoint(config: AiConfig): string | null {
  const base = config.baseUrl?.trim().replace(/\/+$/, '');
  if (config.provider === 'custom') return base || null;
  return base || DEFAULT_ENDPOINTS[config.provider as keyof typeof DEFAULT_ENDPOINTS] || null;
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
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        },
      };

    case 'gemini':
      return {
        url: `${endpoint}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
        headers: { 'content-type': 'application/json' },
        body: {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
          },
        },
      };

    // OpenAI's chat-completions shape is the de-facto standard, so "custom"
    // (LM Studio, Ollama's OpenAI bridge, OpenRouter, a corporate gateway…)
    // rides the same path — minus the JSON-mode field, which non-OpenAI
    // implementations frequently reject with a 400.
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
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(config.provider === 'openai' ? { response_format: { type: 'json_object' } } : {}),
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

export interface ProviderError {
  status: number | null;
  message: string;
}

export type ProviderResult =
  | { ok: true; text: string | null }
  | { ok: false; error: ProviderError };

/**
 * Calls the provider once.
 *
 * Returns a discriminated result rather than null, because the batch runner
 * needs to tell "the model had nothing to say" (keep going) apart from "the
 * key is wrong" (stop, and tell the user why). The old code collapsed both
 * into null, which is how a misconfigured key looked identical to a quiet
 * model and produced a job that reported success while doing nothing.
 */
export async function callProvider(
  config: AiConfig,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult> {
  const req = buildProviderRequest(config, prompt);
  if (!req) {
    return { ok: false, error: { status: null, message: '接口地址未配置' } };
  }

  try {
    const response = await fetchImpl(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        error: {
          status: response.status,
          message: describeStatus(response.status, detail),
        },
      };
    }

    const payload = (await response.json()) as unknown;
    return { ok: true, text: extractText(config.provider, payload) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        status: null,
        message: /abort|timeout/i.test(message) ? '模型响应超时' : `请求失败：${message}`,
      },
    };
  }
}

/** Turns an HTTP status into something a user can act on. */
function describeStatus(status: number, detail: string): string {
  const snippet = detail.slice(0, 200);
  if (status === 401 || status === 403) return 'API Key 无效或无权限';
  if (status === 404) return '模型或接口地址不存在';
  if (status === 429) return '触发服务商限流，请稍后再试';
  if (status >= 500) return '服务商暂时不可用';
  return `服务商返回 ${status}${snippet ? `：${snippet}` : ''}`;
}

/** True when retrying the same request could plausibly succeed. */
export function isRetryable(error: ProviderError): boolean {
  if (error.status === null) return true; // timeout / network
  return error.status === 429 || error.status >= 500;
}

/** True when the whole job should stop rather than burn through the batch. */
export function isFatal(error: ProviderError): boolean {
  return error.status === 401 || error.status === 403 || error.status === 404;
}

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
 * Reads an optional numeric override from the environment, tolerating runtimes
 * where `process` is unavailable (edge deployments). Falls back to `fallback`.
 */
function envNumber(name: string, fallback: number): number {
  try {
    const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Per-call model request deadline.
 *
 * Must stay *well* under the Cloudflare Pages Functions wall-clock (≈30s) and
 * the client's per-partition deadline (28s in `useOrganizeRun`), leaving
 * headroom for the D1 writes and — on the finisher — the shared-state
 * finalize. A single partition is exactly one model call now (page fetching was
 * removed in 方案A), so 20s leaves ~8s for everything else and still fits before
 * the 28s client timeout fires. Override with `TN_AI_TIMEOUT_MS`.
 */
export const REQUEST_TIMEOUT_MS = envNumber('TN_AI_TIMEOUT_MS', 20_000);

/**
 * Maximum provider attempts for one logical call (override `TN_AI_MAX_RETRIES`).
 *
 * Kept low on purpose: under the Pages Functions 30s wall a partition cannot
 * survive many serial attempts, and — critically — *timeouts are not retried at
 * all* (see `isTransientRetryable`), so this only bounds retries of fast,
 * transient 429/5xx responses. A slow model that already timed out will only
 * time out again, and retrying it is exactly what used to push every partition
 * past the wall and surface as "0/168 + 请求超时". Default 2 gives one cheap
 * retry for a flaky gateway without any risk of a multi-minute loop.
 */
export const RETRY_MAX_ATTEMPTS = envNumber('TN_AI_MAX_RETRIES', 2);

const BACKOFF_BASE_MS = 1_500;
const BACKOFF_FACTOR = 2;
const BACKOFF_MAX_MS = 30_000;

/**
 * Exponential backoff delay (ms) before the n-th retry (n>=1): 1.5s · 2^(n-1),
 * capped at 30s — matches the reference project's schedule. Returns 0 for n<=0.
 */
export function backoffDelayMs(retryIndex: number): number {
  if (retryIndex <= 0) return 0;
  const raw = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, retryIndex - 1);
  return Math.min(raw, BACKOFF_MAX_MS);
}

/** Promise-based delay; setTimeout is available in Node and Workers. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Merges the caller's abort signal (if any) with a hard deadline.
 *
 * `AbortSignal.timeout(ms)` fires the deadline; if the caller also passes a
 * signal — e.g. the partition budget created in `run.ts` — `AbortSignal.any`
 * rejects as soon as *either* fires, so a single partition can never outlive its
 * budget even if `REQUEST_TIMEOUT_MS` is misconfigured larger than it.
 */
function withDeadline(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!signal) return deadline;
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return any ? any([signal, deadline]) : deadline;
}

export type RetryVerdict = 'ok' | 'retry' | 'stop';

/**
 * Runs `attempt` up to `maxAttempts` times with exponential backoff between
 * retryable failures. `classify` returns:
 *  - 'ok'   → return the result immediately (success).
 *  - 'stop' → return the result immediately, no further attempts.
 *  - 'retry'→ wait (backoff) and retry if attempts remain.
 *
 * Centralises the retry/backoff policy so the tagging and tree-synthesis paths
 * share one configurable implementation instead of three copies.
 */
export async function withRetry<T>(
  attempt: (n: number) => Promise<T>,
  classify: (result: T) => RetryVerdict,
  opts: { maxAttempts?: number } = {},
  signal?: AbortSignal,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS;
  let last: T | undefined;
  for (let n = 1; n <= maxAttempts; n += 1) {
    // Always run at least the first attempt; after that, bail the moment the
    // partition budget has been spent rather than burning more calls we cannot
    // afford under the Functions wall-clock.
    last = await attempt(n);
    const verdict = classify(last);
    if (verdict === 'ok' || verdict === 'stop') return last;
    if (signal?.aborted) break;
    if (n < maxAttempts) await sleep(backoffDelayMs(n));
  }
  return last as T;
}

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
          // Operator-controlled gateway tuning (managed tier), e.g.
          // `enable_thinking:false` for reasoning models. Spread FIRST so the
          // fixed fields below always win — extraBody can add knobs, never
          // override identity/safety fields.
          ...(config.extraBody ?? {}),
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
  signal?: AbortSignal,
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
      signal: withDeadline(signal, REQUEST_TIMEOUT_MS),
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

/**
 * True only for *fast, transient* HTTP failures — rate limits and 5xx.
 *
 * Deliberately excludes timeouts / network errors (`status === null`). Under the
 * Cloudflare Pages Functions 30s wall-clock a model call that already timed out
 * will only time out again; retrying it serially is what used to make a single
 * 10-bookmark partition run for 5 × 25s ≈ 125s, blow the wall, and surface to
 * the user as "0/168 + 请求超时". On a timeout we therefore stop immediately and
 * let the engine degrade to its domain fallback for that slice.
 */
export function isTransientRetryable(error: ProviderError): boolean {
  const status = error.status;
  return status !== null && (status === 429 || status >= 500);
}

/** True when the whole job should stop rather than burn through the batch. */
export function isFatal(error: ProviderError): boolean {
  return error.status === 401 || error.status === 403 || error.status === 404;
}

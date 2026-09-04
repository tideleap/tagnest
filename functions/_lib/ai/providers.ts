import type { AiProvider } from '../../../shared/types';
import { isBlockedHost } from '../ssrf';
import { parseUrl } from '../urlkey';
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
 * D-5（第二轮审计）: 模型响应体解析上限（字节/字符数）。
 *
 * 旧实现直接 `response.json()`——网关返回任意大的响应体（SSE 事件流、HTML 错误
 * 墙、误配的代理页）都会被完整缓冲并解析，单次调用即可吃掉 Worker 的内存与 CPU。
 * 合法输出受 `MAX_OUTPUT_TOKENS=2048` 约束，不过数 KB；1 MiB 留足约百倍余量，
 * 同时把最坏情况的内存/解析成本钉死。两道防线：`content-length` 头存在时廉价
 * 早拒（不必读 body）；解码后的文本长度是最终事实源（头可能缺失或撒谎）。
 */
export const MAX_RESPONSE_BYTES = 1_048_576; // 1 MiB

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
 * Set a touch ABOVE the 25s partition budget (`TN_PARTITION_BUDGET_MS`) on
 * purpose: `withDeadline` takes `min(partitionRemaining, REQUEST_TIMEOUT_MS)`, so
 * the partition signal — not this constant — is the real ceiling for one model
 * call. A no-fetch track (categorize/rename) can now spend its full 25s instead
 * of being capped at the old 20s, while a fetch track is still bounded by the
 * partition budget after its 8s enrichment. 28s still leaves headroom under the
 * 30s Functions wall-clock and the 28s client cutoff (useOrganizeRun).
 * Override with `TN_AI_TIMEOUT_MS`.
 */
export const REQUEST_TIMEOUT_MS = envNumber('TN_AI_TIMEOUT_MS', 28_000);

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
 *
 * D-5（第二轮审计）: `AbortSignal.any` 不存在时（较旧的 Workers 运行时），旧实现
 * 静默丢弃调用方的分区信号、只保留 28s 超时 —— 分区预算形同虚设且无任何告警。
 * 现手动合并两个信号：任一触发即 abort 返回的控制器，语义与 `any` 一致。
 */
function withDeadline(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!signal) return deadline;
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any([signal, deadline]);

  // Manual merge: a controller that abortes as soon as EITHER source fires.
  const merged = new AbortController();
  const forward = (source: AbortSignal) => {
    if (source.aborted) merged.abort(source.reason);
    else source.addEventListener('abort', () => merged.abort(source.reason), { once: true });
  };
  forward(signal);
  forward(deadline);
  return merged.signal;
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

/**
 * D-5（第二轮审计）: `extraBody` 黑名单。
 *
 * `extraBody` 是运营侧网关调参通道（managed tier），展开在固定字段之前——
 * `model`/`messages` 虽会被后续固定字段覆盖，但 `stream` 没有任何后续字段压制：
 * 注入 `stream: true` 会让网关改吐 SSE 事件流，`JSON.parse` 整段失败，每次调用
 * 都表现为「响应不是有效 JSON」且难以排查。这里在展开前剔除全部身份/安全/
 * 传输控制键，防御性地把「只能加调参旋钮」的约定做实。
 */
const EXTRA_BODY_BLOCKLIST = ['stream', 'messages', 'model'];

export function sanitizeExtraBody(extraBody: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extraBody) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extraBody)) {
    if (EXTRA_BODY_BLOCKLIST.includes(key)) continue;
    out[key] = value;
  }
  return out;
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
      // C-5（第二轮审计）: 密钥改走 `x-goog-api-key` 请求头，不再拼进 URL 查询串。
      // URL 会进入 CF 日志、网关访问日志与错误追踪，是密钥泄漏通道；header 不落
      // 这些日志面，暴露最小化。（Gemini API 官方支持 x-goog-api-key 头。）
      return {
        url: `${endpoint}/models/${encodeURIComponent(config.model)}:generateContent`,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
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
          // override identity/safety fields. D-5: `sanitizeExtraBody` strips
          // `stream`/`messages`/`model` up front (see its doc) — `stream` in
          // particular has no fixed field after it to override it.
          ...sanitizeExtraBody(config.extraBody),
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
 * C-3（第二轮审计）: SSRF-safe fetch for the inference path.
 *
 * Mirrors `safeFetch` in test-connection.ts: follows redirects manually and
 * re-validates EVERY hop against the host blocklist, so a legitimate endpoint
 * cannot 302 the request (and its Authorization header) onto an internal or
 * metadata address. The initial host is validated by the caller before this.
 * Throws on redirect-loop / bad-location so the caller's catch reports it as a
 * network failure rather than silently following.
 */
const MAX_PROVIDER_REDIRECTS = 5;

/** Credential-bearing headers that must never leave the original origin. */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key'];

async function ssrfSafeFetch(
  req: ProviderRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let current = req.url;
  // C-5（第二轮审计）: 跨 origin 重定向时剥离凭据头。旧实现对每一跳复用同一
  // init（含 Authorization / x-api-key / x-goog-api-key），只做黑名单校验——用户
  // 端点一旦 302 到任意主机就把密钥带走。现记录初始 origin，重定向到不同 origin
  // 时从后续请求头中删除全部凭据头（同 origin 跳转保留，行为不变）。
  const originOf = (u: string): string => {
    try {
      return new URL(u).origin;
    } catch {
      return '';
    }
  };
  const initialOrigin = originOf(req.url);
  let headers: Record<string, string> = { ...req.headers };

  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(req.body),
    redirect: 'manual',
    signal,
  };

  for (let hop = 0; hop <= MAX_PROVIDER_REDIRECTS; hop += 1) {
    const res = await fetchImpl(current, init);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      // Drain the redirect body so the connection can be reused.
      await res.arrayBuffer().catch(() => null);
      if (!loc) return res;
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw new Error('重定向地址无效');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error('重定向地址不被允许');
      }
      if (isBlockedHost(next.hostname)) {
        throw new Error('重定向地址不被允许');
      }
      // Strip credentials when the redirect leaves the original origin.
      if (next.origin !== initialOrigin) {
        const stripped: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          if (!CREDENTIAL_HEADERS.includes(k.toLowerCase())) stripped[k] = v;
        }
        headers = stripped;
        init.headers = headers;
      }
      current = next.toString();
      continue;
    }
    return res;
  }
  throw new Error('重定向次数过多');
}

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
  /**
   * Optional context for a more accurate timeout diagnosis.
   * D-3: `fetchesContent` tells the diagnosis whether this track fetches page
   * bodies before the model call (only tagging does). Tracks without a fetch
   * phase must never be told "网页抓取挤占了模型调用时间" — they have no fetch
   * phase to squeeze anything.
   */
  diagnosisCtx?: { partitionBudgetMs?: number; itemCount?: number; fetchesContent?: boolean },
): Promise<ProviderResult> {
  const req = buildProviderRequest(config, prompt);
  if (!req) {
    return { ok: false, error: { status: null, message: '接口地址未配置' } };
  }

  // C-3（第二轮审计）: 推理路径 SSRF 门。baseUrl 用户可控，此前只有
  // test-connection 设防，保存后的每次 /run 都会服务端代打用户指定的任意
  // 地址。与 test-connection 同一防线：协议限定 http/https + 主机黑名单，
  // 且下方 ssrfSafeFetch 以 manual 重定向逐跳复检，堵住 302 跳内网绕过。
  const parsed = parseUrl(req.url);
  if (
    !parsed ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    isBlockedHost(parsed.hostname)
  ) {
    return { ok: false, error: { status: null, message: '接口地址不被允许' } };
  }

  const startedAt = Date.now();
  try {
    const response = await ssrfSafeFetch(req, withDeadline(signal, REQUEST_TIMEOUT_MS), fetchImpl);

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

    // D-5（第二轮审计）: 限长读取响应体，替代无上限的 `response.json()`。
    // ① content-length 可信时廉价早拒；② 否则读文本后按长度判定。超限返回
    // 明确的「响应体过大」错误（status: null → 不重试），避免把网关吐出的
    // 巨型 SSE/HTML 全量缓冲进 Worker 内存。
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      return { ok: false, error: { status: null, message: '模型响应体过大，已拒绝解析' } };
    }
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) {
      return { ok: false, error: { status: null, message: '模型响应体过大，已拒绝解析' } };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { ok: false, error: { status: null, message: '模型响应不是有效 JSON' } };
    }
    return { ok: true, text: extractText(config.provider, payload) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort|timeout/i.test(message)) {
      // Self-diagnosing timeout (2026-08-31): tell the two root causes apart.
      // The caller's `signal` is the partition budget (run.ts).
      //  - If IT is aborted, the partition wall-clock expired. Whether that is
      //    fetch-squeeze or a genuinely slow model depends on how much of the
      //    budget was consumed BEFORE the model call: `preModelMs` below equals
      //    `partitionBudgetMs - modelElapsed`. A large preModelMs means the fetch
      //    phase ate most of the window (squeeze); a small one means the model got
      //    almost the whole window and still couldn't finish (model/gateway slow).
      //    Threshold 6s cleanly separates the two given the 8s fetch cap.
      //  - Otherwise the per-request REQUEST_TIMEOUT_MS ceiling fired first: the
      //    gateway itself is slow.
      const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
      const budget = diagnosisCtx?.partitionBudgetMs ?? 0;
      const preModelMs = budget > 0 ? budget - Number(elapsedS) * 1000 : 0;
      let diagnosed: string;
      if (!signal?.aborted) {
        diagnosed = `模型响应超时（已等待 ${elapsedS}s，单次请求超过 ${REQUEST_TIMEOUT_MS / 1000}s 上限——模型网关响应过慢）`;
      } else if (budget > 0 && preModelMs < 6_000) {
        const rate = diagnosisCtx?.itemCount
          ? `（约 ${(Number(elapsedS) / diagnosisCtx.itemCount).toFixed(2)}s/条）`
          : '';
        diagnosed = `模型响应超时（已等待 ${elapsedS}s，模型已拿满分配时间仍超时${rate}——本网关处理偏慢，建议换更快模型/网关）`;
      } else if (diagnosisCtx?.fetchesContent) {
        diagnosed = `模型响应超时（已等待 ${elapsedS}s，分区时间预算已用尽——网页抓取挤占了模型调用时间）`;
      } else {
        // D-3: 分类/改名轨道没有网页抓取阶段，不能归因「抓取挤占」；
        // 预算耗尽而模型未拿满时间，用中性文案描述。
        diagnosed = `模型响应超时（已等待 ${elapsedS}s，分区时间预算已用尽——建议换更快模型/网关或缩小单次整理范围）`;
      }
      return { ok: false, error: { status: null, message: diagnosed } };
    }
    return { ok: false, error: { status: null, message: `请求失败：${message}` } };
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

/**
 * True only for *fast, transient* HTTP failures — rate limits and 5xx.
 *
 * Deliberately excludes timeouts / network errors (`status === null`). Under the
 * Cloudflare Pages Functions 30s wall-clock a model call that already timed out
 * will only time out again; retrying it serially is what used to make a single
 * 10-bookmark partition run for 5 × 25s ≈ 125s, blow the wall, and surface to
 * the user as "0/168 + 请求超时". On a timeout we therefore stop immediately and
 * let the engine degrade to its domain fallback for that slice.
 *
 * D-5（第二轮审计）: 这是重试判定的唯一事实源。旧文件里还有一个 `isRetryable`
 * （把 timeout/network 也判为可重试），语义与本函数矛盾且已无任何调用方，
 * 属死代码，已删除 —— 避免未来有人误引一个与现行策略相反的判定。
 */
export function isTransientRetryable(error: ProviderError): boolean {
  const status = error.status;
  return status !== null && (status === 429 || status >= 500);
}

/** True when the whole job should stop rather than burn through the batch. */
export function isFatal(error: ProviderError): boolean {
  return error.status === 401 || error.status === 403 || error.status === 404;
}

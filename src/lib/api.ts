import type { ApiError } from '@shared/types';

const BASE = '/api';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isAuthError() {
    return this.status === 401;
  }
}

/** Set by the auth store; kept in memory only. */
let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
/**
 * Optional personal access key. When set, it is sent as `X-API-Key` so the
 * backend's key-auth path (scopes + non-session buckets) is usable from the
 * browser. The session bearer still wins when both are present, which is the
 * case on the management screens — there the key is irrelevant.
 */
let apiKey: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function setApiKey(token: string | null) {
  apiKey = token;
}

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

/**
 * Default request deadline.
 *
 * Without one, a stalled connection leaves the promise pending forever: React
 * Query never sees a failure, so it never retries and the spinner never stops.
 * A bounded wait turns "hung" into "failed", which the UI already knows how to
 * render.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Exports stream the whole library; they get a longer leash. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Distinguishes an expired deadline from a genuine network fault.
 *
 * `AbortSignal.timeout()` rejects with a `TimeoutError` DOMException, while a
 * caller-initiated abort raises `AbortError`. Both surface here as exceptions
 * from `fetch`, and the user-facing wording should not be the same.
 */
export function classifyFetchFailure(error: unknown): HttpError {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError') {
    return new HttpError(0, 'timeout', '请求超时，请稍后重试');
  }
  if (name === 'AbortError') {
    return new HttpError(0, 'aborted', '请求已取消');
  }
  return new HttpError(0, 'network_error', '网络连接失败，请检查网络后重试');
}

/**
 * Merges the caller's abort signal (if any) with the deadline.
 *
 * `AbortSignal.any` is the modern spelling; older engines fall back to the
 * timeout alone rather than losing the deadline entirely.
 */
function withDeadline(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!signal) return deadline;
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return any ? any([signal, deadline]) : deadline;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Bypass the 401 -> logout hook, used by the refresh call itself. */
  skipAuthRedirect?: boolean;
  /** Override the request deadline; defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipAuthRedirect, headers, timeoutMs, signal, ...rest } = options;

  const isFormData = body instanceof FormData;
  const finalHeaders = new Headers(headers);

  if (!isFormData && body !== undefined) {
    finalHeaders.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    finalHeaders.set('Authorization', `Bearer ${accessToken}`);
  } else if (apiKey) {
    finalHeaders.set('X-API-Key', apiKey);
  }

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...rest,
      headers: finalHeaders,
      credentials: 'include',
      signal: withDeadline(signal, timeoutMs ?? DEFAULT_TIMEOUT_MS),
      body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw classifyFetchFailure(error);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const err = payload as ApiError | null;
    if (response.status === 401 && !skipAuthRedirect) {
      onUnauthorized?.();
    }
    throw new HttpError(
      response.status,
      err?.error?.code ?? 'unknown',
      err?.error?.message ?? `请求失败（${response.status}）`,
      err?.error?.details,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, init?: RequestOptions) => request<T>(path, { ...init, method: 'GET' }),
  post: <T>(path: string, body?: unknown, init?: RequestOptions) =>
    request<T>(path, { ...init, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, init?: RequestOptions) =>
    request<T>(path, { ...init, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, init?: RequestOptions) =>
    request<T>(path, { ...init, method: 'PUT', body }),
  delete: <T>(path: string, init?: RequestOptions) =>
    request<T>(path, { ...init, method: 'DELETE' }),
};

/**
 * Fetches a file response as a Blob.
 *
 * Downloads cannot go through `request()` — the payload is not JSON — but they
 * still need the bearer token, so a bare `fetch` would 401. The access token
 * lives in memory only; there is no cookie the browser could fall back on.
 */
export async function downloadBlob(
  path: string,
): Promise<{ blob: Blob; filename: string | null }> {
  const headers = new Headers();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  else if (apiKey) headers.set('X-API-Key', apiKey);

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw classifyFetchFailure(error);
  }

  if (!response.ok) {
    if (response.status === 401) onUnauthorized?.();
    throw new HttpError(response.status, 'download_failed', `导出失败（${response.status}）`);
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"';]+)"?/i.exec(disposition);

  return { blob: await response.blob(), filename: match?.[1] ?? null };
}

/** Builds a query string, dropping empty values so URLs stay readable. */
export function qs(params: Record<string, string | number | boolean | string[] | null | undefined>) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) sp.set(key, value.join(','));
    } else {
      sp.set(key, String(value));
    }
  }
  const str = sp.toString();
  return str ? `?${str}` : '';
}

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

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Bypass the 401 -> logout hook, used by the refresh call itself. */
  skipAuthRedirect?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipAuthRedirect, headers, ...rest } = options;

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
      body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new HttpError(0, 'network_error', '网络连接失败，请检查网络后重试');
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
    response = await fetch(`${BASE}${path}`, { headers, credentials: 'include' });
  } catch {
    throw new HttpError(0, 'network_error', '网络连接失败，请检查网络后重试');
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

import type { ApiError } from '../../shared/types';

/**
 * Every failure path throws one of these. The middleware turns it into the
 * `ApiError` envelope the browser client already knows how to unwrap, so no
 * handler needs to hand-roll an error response.
 */
export class ApiException extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiException';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: Record<string, string>) =>
  new ApiException(400, 'bad_request', message, details);

export const unauthorized = (message = '登录状态已失效，请重新登录') =>
  new ApiException(401, 'unauthorized', message);

export const forbidden = (message = '没有访问该资源的权限') =>
  new ApiException(403, 'forbidden', message);

export const notFound = (message = '资源不存在') =>
  new ApiException(404, 'not_found', message);

export const conflict = (message: string, details?: Record<string, string>) =>
  new ApiException(409, 'conflict', message, details);

export const tooLarge = (message: string) =>
  new ApiException(413, 'payload_too_large', message);

const NO_STORE = {
  'Content-Type': 'application/json; charset=utf-8',
  // Bookmark data is per-account. An intermediary caching it would be a
  // cross-account leak, so every JSON response opts out explicitly.
  'Cache-Control': 'no-store',
} as const;

export function json<T>(data: T, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...NO_STORE, ...(init.headers ?? {}) },
  });
}

export function noContent(init: ResponseInit = {}): Response {
  return new Response(null, { ...init, status: 204 });
}

/** Whether a status is transient enough that a retry as-is may succeed. */
export function isRetriable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiException) {
    const body: ApiError = {
      error: {
        code: e.code,
        message: e.message,
        ...(e.details ? { details: e.details } : {}),
        retriable: isRetriable(e.status),
      },
    };
    return json(body, { status: e.status });
  }

  // Anything unexpected is reported opaquely; database errors routinely contain
  // table and column names. The API middleware logs it as a structured
  // `request_error` event, so no raw console.error belongs here.
  const body: ApiError = {
    error: { code: 'internal_error', message: '服务器内部错误，请稍后重试', retriable: true },
  };
  return json(body, { status: 500 });
}

/** Parses a JSON body, rejecting anything that is not a plain object. */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('请求体不是合法的 JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('请求体必须是 JSON 对象');
  }
  return raw as T;
}

/** Rejects with 405 unless the request uses one of the allowed methods. */
export function assertMethod(request: Request, ...allowed: string[]) {
  if (!allowed.includes(request.method)) {
    throw new ApiException(405, 'method_not_allowed', `不支持 ${request.method} 方法`);
  }
}

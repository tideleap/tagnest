import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  HttpError,
  api,
  classifyFetchFailure,
  setAccessToken,
  setUnauthorizedHandler,
} from '../src/lib/api';

/**
 * The API client's failure handling is the difference between "the spinner
 * stopped and told me why" and "the tab hung". These tests pin the contract:
 * every abnormal exit maps to a distinct, non-retryable-or-retryable code.
 */

function mockFetch(impl: (input: string, init: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl as never);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
  setUnauthorizedHandler(null);
});

describe('classifyFetchFailure', () => {
  it('separates a deadline from a dropped connection', () => {
    const timeout = classifyFetchFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }));
    expect(timeout.code).toBe('timeout');
    expect(timeout.status).toBe(0);

    const aborted = classifyFetchFailure(Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(aborted.code).toBe('aborted');

    const offline = classifyFetchFailure(new TypeError('Failed to fetch'));
    expect(offline.code).toBe('network_error');
  });

  it('marks timeout and network errors retriable, but a user abort not', () => {
    const timeout = classifyFetchFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }));
    expect(timeout.retriable).toBe(true);
    const offline = classifyFetchFailure(new TypeError('Failed to fetch'));
    expect(offline.retriable).toBe(true);
    const aborted = classifyFetchFailure(Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(aborted.retriable).toBe(false);
  });

  it('never leaks a non-HttpError to callers', () => {
    expect(classifyFetchFailure('not an error')).toBeInstanceOf(HttpError);
    expect(classifyFetchFailure(null)).toBeInstanceOf(HttpError);
  });
});

describe('request deadlines', () => {
  it('attaches an abort signal to every call', async () => {
    const spy = mockFetch(() => new Response(null, { status: 204 }));
    await api.get('/health');

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('surfaces an expired deadline as a timeout, not a network error', async () => {
    mockFetch(() => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));

    await expect(api.get('/bookmarks')).rejects.toMatchObject({
      code: 'timeout',
      status: 0,
    });
  });

  it('honours a caller-supplied deadline override', async () => {
    const spy = mockFetch(() => new Response(null, { status: 204 }));
    await api.get('/health', { timeoutMs: 50 });
    expect((spy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

describe('response handling', () => {
  it('returns undefined for 204 without parsing a body', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(api.delete('/bookmarks/abc')).resolves.toBeUndefined();
  });

  it('maps a structured error payload onto HttpError', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'invalid_url', message: '链接格式不正确' } }), {
          status: 400,
        }),
    );

    await expect(api.post('/bookmarks', {})).rejects.toMatchObject({
      status: 400,
      code: 'invalid_url',
      message: '链接格式不正确',
    });
  });

  it('fires the unauthorized hook on 401 unless explicitly skipped', async () => {
    mockFetch(() => new Response('{}', { status: 401 }));
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    await expect(api.get('/auth/me')).rejects.toBeInstanceOf(HttpError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    await expect(api.post('/auth/refresh', undefined, { skipAuthRedirect: true })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('tolerates a non-JSON error body', async () => {
    mockFetch(() => new Response('<html>502</html>', { status: 502 }));
    await expect(api.get('/stats')).rejects.toMatchObject({ status: 502, code: 'unknown' });
  });
});

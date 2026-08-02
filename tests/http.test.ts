import { describe, it, expect } from 'vitest';
import { isRetriable, errorResponse, badRequest, ApiException } from '../functions/_lib/http';

describe('isRetriable', () => {
  it('marks 429 and 5xx as transient', () => {
    expect(isRetriable(429)).toBe(true);
    expect(isRetriable(500)).toBe(true);
    expect(isRetriable(503)).toBe(true);
  });

  it('keeps 4xx validation/auth errors non-retriable', () => {
    expect(isRetriable(400)).toBe(false);
    expect(isRetriable(401)).toBe(false);
    expect(isRetriable(403)).toBe(false);
    expect(isRetriable(404)).toBe(false);
    expect(isRetriable(409)).toBe(false);
  });
});

describe('errorResponse', () => {
  it('adds retriable:true for a 429 ApiException', async () => {
    const res = errorResponse(new ApiException(429, 'throttled', '太频繁了'));
    const body = await res.json();
    expect(body.error.retriable).toBe(true);
  });

  it('adds retriable:false for a 400 bad request', async () => {
    const res = errorResponse(badRequest('请求体不是合法的 JSON'));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.retriable).toBe(false);
  });

  it('marks a shielded 500 as retriable:true', async () => {
    const res = errorResponse(new Error('db crashed'));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe('internal_error');
    expect(body.error.retriable).toBe(true);
    // The raw error message must never leak to the client.
    expect(body.error.message).not.toContain('db crashed');
  });
});

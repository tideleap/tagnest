import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelayMs,
  RETRY_MAX_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  withRetry,
} from '../functions/_lib/ai/providers';

/**
 * P1-1 — configurable retry / timeout + exponential backoff. These are the
 * exact policies the reference project `ai-bookmark-os` uses (5 attempts / 90s,
 * 1.5·2ⁿ backoff capped at 30s; 429/5xx/timeout retryable, 401/403/404 fatal),
 * now centralised in `withRetry`.
 */
describe('backoffDelayMs (P1-1)', () => {
  it('grows 1.5s · 2^(n-1) and caps at 30s', () => {
    expect(backoffDelayMs(1)).toBe(1500);
    expect(backoffDelayMs(2)).toBe(3000);
    expect(backoffDelayMs(3)).toBe(6000);
    expect(backoffDelayMs(4)).toBe(12000);
    expect(backoffDelayMs(10)).toBe(30000);
  });

  it('returns 0 for a non-positive index', () => {
    expect(backoffDelayMs(0)).toBe(0);
  });
});

describe('withRetry (P1-1)', () => {
  it('retries a retryable failure then succeeds', async () => {
    let n = 0;
    const attempt = vi.fn(async () => {
      n += 1;
      return n < 2 ? { ok: false, retryable: true } : { ok: true };
    });
    const out = await withRetry(
      attempt,
      (r: { ok: boolean; retryable?: boolean }) => (r.ok ? 'ok' : r.retryable ? 'retry' : 'stop'),
      { maxAttempts: 3 },
    );
    expect(out.ok).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('stops immediately on a fatal result (no wasted retries)', async () => {
    const attempt = vi.fn(async () => ({ ok: false, fatal: true }));
    const out = await withRetry(
      attempt,
      (r: { ok: boolean; fatal?: boolean }) => (r.ok ? 'ok' : r.fatal ? 'stop' : 'retry'),
      { maxAttempts: 5 },
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out.fatal).toBe(true);
  });

  it('stops on a non-retryable error (no wasted retries)', async () => {
    const attempt = vi.fn(async () => ({ ok: false, retryable: false }));
    const out = await withRetry(
      attempt,
      (r: { ok: boolean; retryable?: boolean }) => (r.ok ? 'ok' : r.retryable ? 'retry' : 'stop'),
      { maxAttempts: 5 },
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
  });

  it('exposes sane configurable constants', () => {
    expect(RETRY_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(RETRY_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

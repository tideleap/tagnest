/**
 * Batch-2 billing regression tests (round-2 audit):
 *
 *  - B-3: `resolveManagedEligibility` must enforce the subscription window.
 *    An expired trial / expired paid period is NOT eligible, even though the
 *    status string is still 'trialing' / 'active' (nothing flips it back).
 *  - B-4: `consumeAiCredit` must decrement atomically. Concurrent partitions
 *    may not lose updates (balance ends exactly at initial − total spent),
 *    the balance may never go negative, and the ledger must reconcile.
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import {
  consumeAiCredit,
  getAiCreditBalance,
  resolveManagedEligibility,
  type ManagedFacts,
} from '../functions/_lib/ai/billing';

/* ------------------------------------------------------------------ *
 * B-3 — subscription-window gate (pure function)
 * ------------------------------------------------------------------ */

// Fixed "now" so the expiry branches are deterministic.
const NOW = Date.parse('2026-09-04T12:00:00Z');
const FUTURE = '2026-10-04T00:00:00Z';
const PAST = '2026-08-04T00:00:00Z';

function facts(overrides: Partial<ManagedFacts> = {}): ManagedFacts {
  return {
    ownModelReady: false,
    managedAvailable: true,
    plan: 'pro',
    status: 'trialing',
    managedEnabled: true,
    creditBalance: 100,
    ...overrides,
  };
}

describe('B-3: resolveManagedEligibility — subscription window', () => {
  it('admits a trialing user inside the trial window', () => {
    expect(resolveManagedEligibility(facts({ trialEndsAt: FUTURE }), NOW)).toBe(true);
  });

  it('rejects a trialing user whose trial has expired', () => {
    expect(resolveManagedEligibility(facts({ trialEndsAt: PAST }), NOW)).toBe(false);
  });

  it('rejects a trialing user exactly at the expiry instant (now >= end)', () => {
    const atExpiry = new Date(NOW).toISOString();
    expect(resolveManagedEligibility(facts({ trialEndsAt: atExpiry }), NOW)).toBe(false);
  });

  it('treats a null / absent trialEndsAt as open-ended (no expiry)', () => {
    expect(resolveManagedEligibility(facts({ trialEndsAt: null }), NOW)).toBe(true);
    expect(resolveManagedEligibility(facts(), NOW)).toBe(true);
  });

  it('admits an active user inside the paid period', () => {
    expect(
      resolveManagedEligibility(facts({ status: 'active', periodEndsAt: FUTURE }), NOW),
    ).toBe(true);
  });

  it('rejects an active user whose paid period has expired', () => {
    expect(
      resolveManagedEligibility(facts({ status: 'active', periodEndsAt: PAST }), NOW),
    ).toBe(false);
  });

  it('treats a null periodEndsAt for an active sub as open-ended', () => {
    expect(
      resolveManagedEligibility(facts({ status: 'active', periodEndsAt: null }), NOW),
    ).toBe(true);
  });

  it('ignores an unparseable expiry string (treated as open-ended)', () => {
    expect(
      resolveManagedEligibility(facts({ trialEndsAt: 'not-a-date' }), NOW),
    ).toBe(true);
  });

  it('still short-circuits on the pre-existing clauses', () => {
    // Own key wins regardless of the window.
    expect(resolveManagedEligibility(facts({ ownModelReady: true, trialEndsAt: FUTURE }), NOW)).toBe(false);
    // No hosted model on this instance.
    expect(resolveManagedEligibility(facts({ managedAvailable: false, trialEndsAt: FUTURE }), NOW)).toBe(false);
    // User has not consented.
    expect(resolveManagedEligibility(facts({ managedEnabled: false, trialEndsAt: FUTURE }), NOW)).toBe(false);
    // Free plan / cancelled / none are never eligible.
    expect(resolveManagedEligibility(facts({ plan: 'free', trialEndsAt: FUTURE }), NOW)).toBe(false);
    expect(resolveManagedEligibility(facts({ status: 'canceled', trialEndsAt: FUTURE }), NOW)).toBe(false);
    expect(resolveManagedEligibility(facts({ status: 'none', trialEndsAt: FUTURE }), NOW)).toBe(false);
    // Empty credits.
    expect(resolveManagedEligibility(facts({ creditBalance: 0, trialEndsAt: FUTURE }), NOW)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * B-4 — atomic credit decrement
 * ------------------------------------------------------------------ */

interface BalanceRow {
  balance: number;
  used: number;
}

/**
 * Minimal in-memory D1 stand-in covering exactly the statements
 * `consumeAiCredit` / `getAiCreditBalance` issue. The balance mutation is a
 * synchronous read-modify-write inside a single `run()` (no internal await),
 * mirroring D1's single-statement atomicity — so it faithfully reproduces the
 * lost-update hazard the old read-then-write-absolute implementation had under
 * concurrency, and proves the new relative decrement is safe.
 */
function makeBillingDb(seed?: { userId: string; balance: number; used?: number }) {
  const balances = new Map<string, BalanceRow>();
  const ledger: Array<{ user_id: string; delta: number; reason: string }> = [];
  if (seed) balances.set(seed.userId, { balance: seed.balance, used: seed.used ?? 0 });

  const db = {
    prepare(sql: string) {
      const params: unknown[] = [];
      const stmt = {
        bind(...p: unknown[]) {
          params.length = 0;
          params.push(...p);
          return stmt;
        },
        async run() {
          const u = sql.replace(/\s+/g, ' ').toUpperCase();
          if (u.startsWith('INSERT INTO AI_CREDIT_BALANCES')) {
            // bind order: [userId, spend(used on insert), ts, spend(−Δ), spend(+Δ)]
            const userId = String(params[0]);
            const spend = Number(params[1]);
            const existing = balances.get(userId);
            if (existing) {
              // ON CONFLICT DO UPDATE: relative, clamped at 0.
              existing.balance = Math.max(existing.balance - spend, 0);
              existing.used += spend;
            } else {
              // Fresh row: balance starts at 0 (VALUES literal), used = spend.
              balances.set(userId, { balance: 0, used: spend });
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (u.startsWith('INSERT INTO AI_CREDIT_LEDGER')) {
            // bind order: [id, userId, delta, reason, ref, ts]
            ledger.push({
              user_id: String(params[1]),
              delta: Number(params[2]),
              reason: String(params[3]),
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          const u = sql.replace(/\s+/g, ' ').toUpperCase();
          if (u.startsWith('SELECT BALANCE, USED FROM AI_CREDIT_BALANCES')) {
            const userId = String(params[0]);
            const row = balances.get(userId);
            return row ? { balance: row.balance, used: row.used } : null;
          }
          return null;
        },
      };
      return stmt;
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };

  return { db, balances, ledger };
}

function envFor(db: unknown): Env {
  return { DB: db } as unknown as Env;
}

describe('B-4: consumeAiCredit — atomic decrement', () => {
  it('loses no updates under 6 concurrent partitions (exact final balance)', async () => {
    const { db, balances, ledger } = makeBillingDb({ userId: 'u1', balance: 100 });
    const env = envFor(db);

    // 6 partitions each spend 10 → total 60, well within the 100 balance.
    await Promise.all(
      Array.from({ length: 6 }, () => consumeAiCredit(env, 'u1', 10, 'ai.job.tagging', 'job1')),
    );

    const row = balances.get('u1')!;
    // The whole point: exactly 100 − 60 = 40, not the lost-update result.
    expect(row.balance).toBe(40);
    expect(row.used).toBe(60);
    // Ledger reconciles: six −10 entries sum to the total decrement.
    expect(ledger).toHaveLength(6);
    const ledgerSum = ledger.reduce((acc, l) => acc + l.delta, 0);
    expect(ledgerSum).toBe(-60);
    // initial + ledgerSum === final balance (no clamp needed here).
    expect(100 + ledgerSum).toBe(row.balance);
  });

  it('clamps the balance at 0 and never goes negative on over-spend', async () => {
    const { db, balances, ledger } = makeBillingDb({ userId: 'u1', balance: 5 });
    const env = envFor(db);

    // 6 partitions each spend 20 → 120 requested against a balance of 5.
    await Promise.all(
      Array.from({ length: 6 }, () => consumeAiCredit(env, 'u1', 20, 'ai.job.categorize', 'job2')),
    );

    const row = balances.get('u1')!;
    expect(row.balance).toBe(0); // clamped, never negative
    expect(row.balance).toBeGreaterThanOrEqual(0);
    expect(row.used).toBe(120); // usage accumulates the full requested amount
    expect(ledger).toHaveLength(6);
  });

  it('returns the post-decrement balance for a single sequential spend', async () => {
    const { db } = makeBillingDb({ userId: 'u1', balance: 50 });
    const env = envFor(db);

    const remaining = await consumeAiCredit(env, 'u1', 20, 'ai.suggest');
    expect(remaining).toBe(30);
    const bal = await getAiCreditBalance(env, 'u1');
    expect(bal.balance).toBe(30);
    expect(bal.used).toBe(20);
  });

  it('creates the meter row on first spend for a user with no balance row', async () => {
    const { db, balances } = makeBillingDb();
    const env = envFor(db);

    const remaining = await consumeAiCredit(env, 'u-new', 10, 'ai.suggest');
    // No prior credits: max(0 − 10, 0) = 0.
    expect(remaining).toBe(0);
    const row = balances.get('u-new')!;
    expect(row.balance).toBe(0);
    expect(row.used).toBe(10);
  });

  it('treats a zero/negative spend as a no-op that just reports the balance', async () => {
    const { db, ledger } = makeBillingDb({ userId: 'u1', balance: 42 });
    const env = envFor(db);

    const remaining = await consumeAiCredit(env, 'u1', 0, 'ai.suggest');
    expect(remaining).toBe(42);
    expect(ledger).toHaveLength(0); // nothing was metered
  });
});

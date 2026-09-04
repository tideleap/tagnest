import type { Env } from '../env';
import { nowIso, newId } from '../ids';
import { loadAiConfig, loadConfigRow, isModelReady, loadManagedEnabled } from './config';
import type { ConfigRow } from './config';
import type { AiConfig } from './types';
import type { BillingInfo, PlanId, SubStatus } from '../../../shared/types';

/**
 * AI managed-billing — Phase A scaffold.
 *
 * This module is the metering substrate for a paid, hosted tier. It deliberately
 * does NOT contain a payment gateway (Stripe/Polar are deferred until a provider
 * is chosen). What it provides is everything needed to *measure and gate* usage
 * so a gateway can be bolted on later without touching the inference path:
 *
 *   - `getEffectiveAiConfig` — the single decision point the four AI call sites
 *     now consult. It returns the user's own config when they have a key, and
 *     otherwise falls back to the hosted model *only* when the user is on a paid
 *     plan, has credits, and has consented.
 *   - `consumeAiCredit` — decrements the meter per real model call.
 *   - `grantProTrial` / `requireAdmin` — operator tools to hand out trials.
 *
 * Units: 1 credit = 1 bookmark analysed by the hosted model. Predictable beats
 * fair here — the user sees a per-bookmark cost before they start a run.
 */

/* ------------------------------------------------------------------ *
 * Plan catalog
 * ------------------------------------------------------------------ */

/**
 * Per-plan defaults. `trialCredits` is what `grantProTrial` seeds when no
 * explicit amount is given; `allowance` is the denominator shown in the
 * "used / plan" ratio on the dashboard (0 = no cap to compare against yet).
 */
export interface PlanDef {
  label: string;
  trialCredits: number;
  allowance: number;
}

export const PLANS: Record<PlanId, PlanDef> = {
  free: { label: '免费（自托管）', trialCredits: 0, allowance: 0 },
  pro: { label: 'Pro', trialCredits: 200, allowance: 200 },
  team: { label: 'Team', trialCredits: 1000, allowance: 1000 },
  admin: { label: '管理员', trialCredits: 0, allowance: 0 },
};

const DEFAULT_TRIAL_DAYS = 14;

/* ------------------------------------------------------------------ *
 * Managed model spec (pure)
 * ------------------------------------------------------------------ */

export interface ManagedModelSpec {
  provider: 'openai';
  baseUrl: string | null;
  model: string;
  apiKey: string;
  /** Extra request-body fields for gateway tuning (see `AiConfig.extraBody`). */
  extraBody?: Record<string, unknown>;
}

/**
 * Resolves the hosted model's connection details from the environment.
 * Returns null when no key is configured, which is the "managed AI is off"
 * signal every other gate keys off of. OpenAI-compatible: a `MANAGED_AI_BASE_URL`
 * makes it ride any gateway that speaks /chat/completions.
 *
 * `MANAGED_AI_EXTRA_BODY` (JSON object) carries gateway-specific tuning knobs —
 * e.g. `{"enable_thinking":false}` for reasoning models, which cut our measured
 * per-call cost ~23x on the uupt gateway. Malformed JSON is ignored (logged by
 * the caller's error path) rather than taking the whole tier down.
 */
export function getManagedModelSpec(env: Env): ManagedModelSpec | null {
  const key = env.MANAGED_AI_KEY?.trim();
  if (!key) return null;
  const model = env.MANAGED_AI_MODEL?.trim() || 'gpt-4o-mini';
  const baseUrl = env.MANAGED_AI_BASE_URL?.trim() || null;
  const extraBody = parseExtraBody(env.MANAGED_AI_EXTRA_BODY);
  return { provider: 'openai', baseUrl, model, apiKey: key, extraBody };
}

/** Parses the optional JSON object; anything unparseable reads as undefined. */
function parseExtraBody(raw: string | undefined): Record<string, unknown> | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** True when this instance can serve a hosted model at all. */
export function isManagedAiAvailable(env: Env): boolean {
  return getManagedModelSpec(env) !== null;
}

/**
 * Builds the config the engine actually runs with when on the hosted tier.
 * Reuses the user's own automation preferences (autoTag / autoSummarize /
 * maxTags / twoPass / fetchContent) — the hosted key only replaces *whose*
 * credential pays, not *how* the model is driven.
 */
export function buildManagedConfig(env: Env, ownRow: ConfigRow): AiConfig {
  const spec = getManagedModelSpec(env)!; // caller guarantees availability
  return {
    provider: spec.provider,
    baseUrl: spec.baseUrl,
    model: spec.model,
    apiKey: spec.apiKey,
    autoTag: ownRow.autoTag,
    autoSummarize: ownRow.autoSummarize,
    autoApplyThreshold: ownRow.autoApplyThreshold,
    maxTags: ownRow.maxTags,
    fetchContent: ownRow.fetchContent,
    twoPass: ownRow.twoPass,
    extraBody: spec.extraBody,
  };
}

/* ------------------------------------------------------------------ *
 * Eligibility (pure) — the heart of the fallback decision
 * ------------------------------------------------------------------ */

export interface ManagedFacts {
  /** User has a usable own key (provider + model + key + a toggle). */
  ownModelReady: boolean;
  /** This instance serves a hosted model (MANAGED_AI_KEY present). */
  managedAvailable: boolean;
  plan: PlanId;
  status: SubStatus;
  /** User consented to hosted inference. */
  managedEnabled: boolean;
  /** Remaining hosted credits. */
  creditBalance: number;
  /**
   * B-3（第二轮审计）: subscription window bounds (ISO-8601 strings), null =
   * open-ended. `trialEndsAt` gates a `trialing` sub, `periodEndsAt` an
   * `active` one. Without a payment gateway nothing ever flips an expired
   * trial back to `none`, so the eligibility gate must check the clock itself.
   */
  trialEndsAt?: string | null;
  periodEndsAt?: string | null;
}

/**
 * Pure decision: should this request run on the hosted model?
 *
 * Own key always wins (a paying user shouldn't burn credits they don't have
 * to). Otherwise the user must be on a paid, non-cancelled plan **inside its
 * validity window**, have consented, and have credits left. Every clause is
 * independently testable.
 *
 * `now` is injectable so the expiry branches are deterministic under test.
 */
export function resolveManagedEligibility(f: ManagedFacts, now: number = Date.now()): boolean {
  if (f.ownModelReady) return false;
  if (!f.managedAvailable) return false;
  if (!f.managedEnabled) return false;
  if (f.plan === 'free' || f.status === 'none' || f.status === 'canceled') return false;
  // B-3（第二轮审计）: enforce the subscription window. A `trialing` sub is only
  // usable before `trialEndsAt`; an `active` sub only before `periodEndsAt`.
  // A null/absent/unparseable bound is treated as open-ended (no expiry).
  if (f.status === 'trialing') {
    const ends = f.trialEndsAt ? Date.parse(f.trialEndsAt) : Number.NaN;
    if (Number.isFinite(ends) && now >= ends) return false;
  } else if (f.status === 'active') {
    const ends = f.periodEndsAt ? Date.parse(f.periodEndsAt) : Number.NaN;
    if (Number.isFinite(ends) && now >= ends) return false;
  }
  if (f.creditBalance <= 0) return false;
  return true;
}

export interface EffectiveConfig {
  config: AiConfig;
  /** True when the hosted key is being used (so the caller must meter). */
  managed: boolean;
}

/**
 * The single entry point the four AI call sites now consult.
 *
 * Short-circuits before any billing query when the user's own key is ready or
 * the instance has no hosted model — so a free, BYO-key deployment behaves
 * exactly as before and never touches the billing tables.
 */
/**
 * @param preloadedRow 已读取的配置行（可选）。方案A 性能优化：run.ts 每分片
 *   只调一次 `loadConfigRow`（含解密 API key），把同一行传入此处，避免
 *   getEffectiveAiConfig 内部二次读库 + 二次解密。并行 6 分片下每趟原 18 次
 *   读 ai_settings + 18 次解密，改为 6 次，释放 25s 分区预算给模型调用。
 */
export async function getEffectiveAiConfig(
  env: Env,
  userId: string,
  preloadedRow?: ConfigRow,
): Promise<EffectiveConfig | null> {
  const ownRow = preloadedRow ?? (await loadConfigRow(env, userId));
  if (isModelReady(ownRow)) {
    const config = await loadAiConfig(env, userId, ownRow);
    return config ? { config, managed: false } : null;
  }

  if (!isManagedAiAvailable(env)) return null;

  const sub = await getSubscription(env, userId);
  const bal = await getAiCreditBalance(env, userId);

  const eligible = resolveManagedEligibility({
    ownModelReady: false,
    managedAvailable: true,
    plan: sub.plan,
    status: sub.status,
    managedEnabled: ownRow.managedEnabled,
    creditBalance: bal.balance,
    // B-3（第二轮审计）: 把订阅窗口交给资格判定，过期试用/订阅不再放行。
    trialEndsAt: sub.trialEndsAt,
    periodEndsAt: sub.periodEndsAt,
  });
  if (!eligible) return null;

  return { config: buildManagedConfig(env, ownRow), managed: true };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface Subscription {
  plan: PlanId;
  status: SubStatus;
  trialEndsAt: string | null;
  periodEndsAt: string | null;
}

const FREE_SUB: Subscription = { plan: 'free', status: 'none', trialEndsAt: null, periodEndsAt: null };

/** Returns the user's subscription, or a free/none default when absent. */
export async function getSubscription(env: Env, userId: string): Promise<Subscription> {
  const row = await env.DB.prepare(`SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!row) return FREE_SUB;
  return {
    plan: ((row.plan as PlanId) ?? 'free') || 'free',
    status: ((row.status as SubStatus) ?? 'none') || 'none',
    trialEndsAt: (row.trial_ends_at as string | null) ?? null,
    periodEndsAt: (row.period_ends_at as string | null) ?? null,
  };
}

/** Returns the live credit meter, or an empty (0/0) default when absent. */
export async function getAiCreditBalance(env: Env, userId: string): Promise<{ balance: number; used: number }> {
  const row = await env.DB.prepare(`SELECT balance, used FROM ai_credit_balances WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!row) return { balance: 0, used: 0 };
  return {
    balance: Number(row.balance ?? 0),
    used: Number(row.used ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Decrements the meter by `units` and appends a ledger row. Returns the
 * remaining balance (so a caller can short-circuit a run at empty if it wants).
 *
 * B-4（第二轮审计）: 原子扣减。旧实现先 SELECT 余额、再按**绝对值** UPSERT
 * (`balance = excluded.balance`)——两次并发调用各自读到旧余额、各写
 * `current.balance - spend`，产生丢失更新（余额 5 可被并行 6 分片超扣）。
 * 现改为单语句相对量扣减 `balance = MAX(balance - ?, 0), used = used + ?`：
 * 无论多少分片并发，D1 逐语句串行执行，各自从当前余额扣自己的量，互不覆盖；
 * `MAX(…, 0)` 保证余额永不为负。扣减后再读回真实余额返回。
 */
export async function consumeAiCredit(
  env: Env,
  userId: string,
  units: number,
  reason: string,
  ref?: string,
): Promise<number> {
  const spend = Math.max(0, Math.trunc(units));
  if (spend === 0) return (await getAiCreditBalance(env, userId)).balance;

  const ts = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_credit_balances (user_id, balance, used, updated_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         balance = MAX(balance - ?, 0),
         used = used + ?,
         updated_at = excluded.updated_at`,
    ).bind(userId, spend, ts, spend, spend),
    env.DB.prepare(
      `INSERT INTO ai_credit_ledger (id, user_id, delta, reason, ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(newId(), userId, -spend, reason, ref ?? null, ts),
  ]);

  // Read back the post-decrement balance. Under concurrency this may already
  // reflect a later decrement, but the stored balance itself is correct — the
  // decrement above is atomic, so no update is ever lost.
  return (await getAiCreditBalance(env, userId)).balance;
}

export interface GrantResult {
  userId: string;
  email: string;
  plan: PlanId;
  status: SubStatus;
  credits: number;
}

/**
 * Grants (or refreshes) a trial for the user with `email`. Idempotent per
 * email: re-granting tops up the credits and extends the window rather than
 * creating a second subscription row. Used by both the admin endpoint and a
 * future CLI. The credit seed defaults to the plan's trial allowance.
 */
export async function grantProTrial(
  env: Env,
  email: string,
  opts: { plan?: PlanId; credits?: number; days?: number } = {},
): Promise<GrantResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('email 不能为空');

  const user = await env.DB.prepare(`SELECT id, email FROM users WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first<{ id: string; email: string }>();
  if (!user) throw new Error(`未找到邮箱为 ${email} 的用户`);

  const plan: PlanId = opts.plan && opts.plan !== 'free' ? opts.plan : 'pro';
  const def = PLANS[plan];
  const credits = Math.max(0, Math.trunc(opts.credits ?? def.trialCredits));
  const days = Math.max(1, Math.trunc(opts.days ?? DEFAULT_TRIAL_DAYS));

  const ts = nowIso();
  const expires = new Date(Date.now() + days * 86_400_000).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscriptions (user_id, plan, status, trial_ends_at, period_ends_at, created_at, updated_at)
       VALUES (?, ?, 'trialing', ?, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         plan = excluded.plan,
         status = 'trialing',
         trial_ends_at = excluded.trial_ends_at,
         period_ends_at = NULL,
         updated_at = excluded.updated_at`,
    ).bind(user.id, plan, expires, ts, ts),
    env.DB.prepare(
      `INSERT INTO ai_credit_balances (user_id, balance, used, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         balance = balance + excluded.balance,
         updated_at = excluded.updated_at`,
    ).bind(user.id, credits, ts),
  ]);

  return { userId: user.id, email: user.email, plan, status: 'trialing', credits };
}

/* ------------------------------------------------------------------ *
 * Admin gate (operator tooling)
 * ------------------------------------------------------------------ */

/**
 * Constant-time string compare so a timing side-channel can't brute-force the
 * admin token. Both operands are treated as opaque byte sequences.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * True only when the request carries the operator `ADMIN_TOKEN`. When the
 * token is unset on the instance, returns false (callers should answer 503 so a
 * misconfigured instance never exposes an open grant path).
 */
export function requireAdmin(env: Env, request: Request): boolean {
  const token = env.ADMIN_TOKEN?.trim();
  if (!token) return false;
  const header = request.headers.get('x-admin-token') || request.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  if (!presented) return false;
  return constantTimeEqual(token, presented);
}

/* ------------------------------------------------------------------ *
 * Aggregate status for the client
 * ------------------------------------------------------------------ */

/** Everything the settings UI needs to render plan + meter state. */
export async function getBillingStatus(env: Env, userId: string): Promise<BillingInfo> {
  const sub = await getSubscription(env, userId);
  const bal = await getAiCreditBalance(env, userId);
  // A-5（第二轮审计）: only the consent flag is needed here — the old
  // `loadConfigRow` pulled the whole row and decrypted the API key on every
  // settings render just to read one boolean.
  const managedEnabled = await loadManagedEnabled(env, userId);
  const managedAvailable = isManagedAiAvailable(env);
  const plan = PLANS[sub.plan]?.allowance ?? 0;

  return {
    plan: sub.plan,
    status: sub.status,
    managedAvailable,
    managedEnabled,
    credits: {
      balance: bal.balance,
      used: bal.used,
      plan,
    },
    isTrial: sub.status === 'trialing',
  };
}

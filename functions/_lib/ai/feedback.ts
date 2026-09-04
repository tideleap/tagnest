import type { Env } from '../env';
import { newId, nowIso } from '../ids';
import { normalizeKey } from './taxonomy';

/**
 * User feedback memory for the AI tagger.
 *
 * ## Why this exists
 *
 * Phase 1 made proposals structured (tags + summary + topic + needsReview).
 * But a proposal the user accepts this week is just as likely to be proposed
 * — and ignored — next week, because nothing the user did flowed back into the
 * decision. `ai_feedback` is that loop: every accept / reject / modify is
 * recorded with the bookmark's domain, then aggregated into a `FeedbackProfile`
 * that bends the *next* run's confidence numbers.
 *
 * The signal is deliberately local and interpretable:
 *
 *   - a tag the user repeatedly accepts on `github.com` gets a boost there;
 *   - a tag they keep rejecting is dropped, not just lowered;
 *   - a tag they renamed "React" → "React.js" makes future "React" suggestions
 *     prefer "React.js".
 *
 * No model, no embedding, no cross-user data. Just a per-user tally that is
 * trivial to unit-test and cheap to load.
 */

export type FeedbackAction = 'accepted' | 'rejected' | 'modified';

/** One aggregated (tag, optional domain) tally. */
export interface FeedbackStat {
  accepted: number;
  rejected: number;
}

/**
 * The decision-relevant view of a user's history, pre-aggregated so the
 * scoring hot path touches a Map rather than re-querying the database per
 * bookmark. Built by `buildFeedbackProfile` (pure, testable).
 */
export interface FeedbackProfile {
  /** Normalised tag name → tally. The broad signal. */
  byTag: Map<string, FeedbackStat>;
  /** `${normalisedTag}|${domain}` → tally. The precise, same-site signal. */
  byTagDomain: Map<string, FeedbackStat>;
  /**
   * Normalised original tag name → the tag name the user switched it to.
   * Populated from `modified` actions; consulted by `renameByFeedback` so the
   * engine proposes the user's preferred spelling next time.
   */
  modifiedTo: Map<string, string>;
  /** Total events, handy for sanity checks / future decay. */
  total: number;
}

/** A row to write into `ai_feedback`. */
export interface FeedbackRecord {
  bookmarkId: string;
  tagName: string;
  action: FeedbackAction;
  /** `modified` only: the tag the user switched to (its id, if known). */
  finalTagId?: string | null;
  source?: string | null;
  confidence?: number | null;
  /** Bookmark domain, for the (tag, domain) signal. */
  domain?: string | null;
  /** Title/domain/topic summary; for `modified`, holds the new tag name. */
  context?: string | null;
}

/* ------------------------------------------------------------------ *
 * Thresholds and multipliers
 * ------------------------------------------------------------------ */

/** Acceptance rate at/above which a tag is trusted more. */
export const FEEDBACK_ACCEPT_RATE = 0.7;
/** Reject share at/above which a tag is dropped outright. */
export const FEEDBACK_REJECT_RATE = 0.7;
/** Multiplier applied to a strongly-accepted tag's confidence. */
export const FEEDBACK_ACCEPT_BOOST = 1.15;
/** Floor multiplier for a tag with a mixed (partly-rejected) history. */
export const FEEDBACK_MIXED_FLOOR = 0.6;

export interface FeedbackEffect {
  /** Confidence multiplier to apply (1 = no change). */
  mult: number;
  /** True when the tag should be dropped regardless of base confidence. */
  drop: boolean;
}

/**
 * Pure decision from a tally.
 *
 *   - reject share ≥ 0.7  → drop (the user has spoken clearly)
 *   - accept rate ≥ 0.7    → ×1.15
 *   - otherwise            → mild penalty scaled by reject share, but never
 *                            below FEEDBACK_MIXED_FLOOR, so a single rejection
 *                            does not nuke a tag the user usually accepts.
 */
export function feedbackMultiplier(stat: FeedbackStat | undefined): FeedbackEffect {
  if (!stat || stat.accepted + stat.rejected === 0) return { mult: 1, drop: false };
  const total = stat.accepted + stat.rejected;
  const acceptRate = stat.accepted / total;
  const rejectRate = stat.rejected / total;

  if (rejectRate >= FEEDBACK_REJECT_RATE) return { mult: 0, drop: true };
  if (acceptRate >= FEEDBACK_ACCEPT_RATE) return { mult: FEEDBACK_ACCEPT_BOOST, drop: false };
  return { mult: Math.max(FEEDBACK_MIXED_FLOOR, 1 - 0.4 * rejectRate), drop: false };
}

/**
 * Builds a profile from raw feedback rows. Pure so the aggregation logic is
 * unit-testable without a database.
 */
export function buildFeedbackProfile(
  rows: ReadonlyArray<{
    tagName: string;
    action: FeedbackAction;
    domain?: string | null;
    finalTagId?: string | null;
    context?: string | null;
  }>,
): FeedbackProfile {
  const byTag = new Map<string, FeedbackStat>();
  const byTagDomain = new Map<string, FeedbackStat>();
  const modifiedTo = new Map<string, string>();
  let total = 0;

  const bump = (map: Map<string, FeedbackStat>, key: string, kind: 'accepted' | 'rejected') => {
    const cur = map.get(key) ?? { accepted: 0, rejected: 0 };
    cur[kind] += 1;
    map.set(key, cur);
  };

  for (const row of rows) {
    total += 1;
    const key = normalizeKey(row.tagName);
    if (row.action === 'accepted') {
      bump(byTag, key, 'accepted');
      if (row.domain) bump(byTagDomain, `${key}|${row.domain}`, 'accepted');
    } else if (row.action === 'rejected') {
      bump(byTag, key, 'rejected');
      if (row.domain) bump(byTagDomain, `${key}|${row.domain}`, 'rejected');
    } else if (row.action === 'modified') {
      // A rename is itself an accept of the new name and a rejection of the
      // old spelling, plus a mapping the engine should prefer next time.
      bump(byTag, key, 'rejected');
      if (row.domain) bump(byTagDomain, `${key}|${row.domain}`, 'rejected');
      const replacement = (row.context ?? row.finalTagId ?? '').trim();
      if (replacement) modifiedTo.set(key, replacement);
    }
  }

  return { byTag, byTagDomain, modifiedTo, total };
}

/** Returns the user-preferred spelling for `name`, or `name` if none recorded. */
export function renameByFeedback(name: string, profile: FeedbackProfile): string {
  if (profile.modifiedTo.size === 0) return name;
  return profile.modifiedTo.get(normalizeKey(name)) ?? name;
}

/* ------------------------------------------------------------------ *
 * Evaluation metrics (Phase 5 — observability)
 *
 * The `ai_feedback` table is the raw signal: one row per decision the user
 * made. These helpers turn it into the numbers a dashboard can show — how
 * often the user kept a suggestion (acceptance rate), how often a proposed
 * tag was ultimately accepted (hit rate / precision), and a per-day trend so
 * the line can move up or down in front of the user instead of living only in
 * an admin panel. All of it is pure so the arithmetic is unit-testable without
 * a database, and the public `load*` wrappers are thin SQL over the same logic.
 * ------------------------------------------------------------------ */

/** A single decision tallied for the dashboard. */
export interface FeedbackTally {
  total: number;
  accepted: number;
  rejected: number;
  modified: number;
  /**
   * Fraction (0..1) of *resolved* decisions the user kept a suggestion for.
   * A rename counts as "kept" (the user wanted a tag, just not that spelling),
   * so `kept = accepted + modified` over `accepted + rejected + modified`.
   */
  acceptanceRate: number;
}

/**
 * Pure aggregation of feedback actions into headline counts and an acceptance
 * rate. `modified` is treated as a kept suggestion, not a rejection, because the
 * user accepted the *idea* of tagging and only corrected the wording — that is
 * exactly the signal Phase 2 feeds back into the engine via `renameByFeedback`.
 */
export function summarizeFeedback(actions: ReadonlyArray<FeedbackAction>): FeedbackTally {
  let accepted = 0;
  let rejected = 0;
  let modified = 0;
  for (const a of actions) {
    if (a === 'accepted') accepted += 1;
    else if (a === 'rejected') rejected += 1;
    else if (a === 'modified') modified += 1;
  }
  const kept = accepted + modified;
  const resolved = accepted + rejected + modified;
  return {
    total: actions.length,
    accepted,
    rejected,
    modified,
    acceptanceRate: resolved === 0 ? 0 : kept / resolved,
  };
}

/**
 * Precision of the suggestion engine across the whole queue: of every tag ever
 * proposed (all statuses, including still-pending), what share did the user
 * ultimately accept? This is intentionally broader than `acceptanceRate`,
 * which only reflects decisions already made — `hitRate` shows whether the
 * *pipeline* is producing tags worth keeping, pending items included.
 */
export function computeHitRate(proposalAccepted: number, proposalTotal: number): number {
  if (proposalTotal <= 0) return 0;
  return proposalAccepted / proposalTotal;
}

/** One point on the evaluation trend chart. */
export interface FeedbackTrendPoint {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  accepted: number;
  rejected: number;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Builds a contiguous daily series of the last `days` days (inclusive of
 * `endDate`), filling gaps with zero so the chart never has holes. `rows` are
 * pre-aggregated `(day, action, count)` tuples from the database; anything
 * outside the window, or in a shape we do not recognise, is ignored.
 *
 * Pure: pass `endDate` explicitly in tests to keep the window deterministic.
 */
export function buildFeedbackTrend(
  rows: ReadonlyArray<{ day: string; action: FeedbackAction; count: number }>,
  days = 30,
  endDate: Date = new Date(),
): FeedbackTrendPoint[] {
  const end = toDateKey(endDate);
  const byDay = new Map<string, { accepted: number; rejected: number }>();
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.day)) continue;
    const bucket = byDay.get(r.day) ?? { accepted: 0, rejected: 0 };
    if (r.action === 'accepted') bucket.accepted += r.count;
    else if (r.action === 'rejected') bucket.rejected += r.count;
    // 'modified' is folded into acceptance on the dashboard; for the trend we
    // keep the raw accept/reject split so the daily volume stays honest.
    byDay.set(r.day, bucket);
  }

  const series: FeedbackTrendPoint[] = [];
  const cursor = new Date(`${end}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    const key = toDateKey(cursor);
    const bucket = byDay.get(key) ?? { accepted: 0, rejected: 0 };
    series.push({ date: key, accepted: bucket.accepted, rejected: bucket.rejected });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return series;
}

/** What the overview endpoint surfaces about suggestion quality. */
export interface FeedbackMetrics extends FeedbackTally {
  /** Total proposed suggestions ever written (all statuses). */
  proposalTotal: number;
  /** Of those, how many were accepted by the user. */
  proposalAccepted: number;
  /** Precision across the whole queue, 0..1. */
  hitRate: number;
}

/**
 * Aggregates the user's decision history into the dashboard metrics.
 *
 * Two counts feed it:
 *   - the `ai_feedback` action tally (accept / reject / modify),
 *   - the `tag_suggestions` status tally (accepted / rejected / pending / ...).
 * Kept as one batched query set so the overview endpoint stays a single
 * round-trip against the database.
 */
export async function loadFeedbackMetrics(
  env: Env,
  userId: string,
): Promise<FeedbackMetrics> {
  const [actionRows, statusRows] = await Promise.all([
    env.DB.prepare(
      `SELECT action, COUNT(*) AS c FROM ai_feedback WHERE user_id = ? GROUP BY action`,
    )
      .bind(userId)
      .all<{ action: FeedbackAction; c: number }>(),

    env.DB.prepare(
      `SELECT status, COUNT(*) AS c FROM tag_suggestions WHERE user_id = ? GROUP BY status`,
    )
      .bind(userId)
      .all<{ status: string; c: number }>(),
  ]);

  // A-5（第二轮审计）: the query already returns one row per action with its
  // count — tally straight from those counts instead of expanding them back
  // into a flat per-event array just to re-count it (O(total) allocation for
  // no behavioural gain). `summarizeFeedback` stays for callers that hold a
  // genuine per-event list.
  let accepted = 0;
  let rejected = 0;
  let modified = 0;
  for (const r of actionRows.results) {
    const c = Number(r.c);
    if (r.action === 'accepted') accepted += c;
    else if (r.action === 'rejected') rejected += c;
    else if (r.action === 'modified') modified += c;
  }
  const kept = accepted + modified;
  const resolved = accepted + rejected + modified;
  const tally: FeedbackTally = {
    total: actionRows.results.reduce((sum, r) => sum + Number(r.c), 0),
    accepted,
    rejected,
    modified,
    acceptanceRate: resolved === 0 ? 0 : kept / resolved,
  };

  const byStatus = new Map(statusRows.results.map((r) => [String(r.status), Number(r.c)]));
  const proposalAccepted = byStatus.get('accepted') ?? 0;
  const proposalTotal = statusRows.results.reduce((sum, r) => sum + Number(r.c), 0);

  return {
    ...tally,
    proposalTotal,
    proposalAccepted,
    hitRate: computeHitRate(proposalAccepted, proposalTotal),
  };
}

/**
 * Daily accept/reject counts for the last `days` days, for the trend chart.
 * The window cutoff is computed in UTC from the current time; the caller can
 * pass a fixed `endDate` only through `buildFeedbackTrend`'s pure path — here
 * we read "now" so the dashboard always shows up-to-date history.
 */
export async function loadFeedbackTrend(
  env: Env,
  userId: string,
  days = 30,
): Promise<FeedbackTrendPoint[]> {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const cutoff = start.toISOString();

  const rows = await env.DB.prepare(
    `SELECT DATE(created_at) AS day, action, COUNT(*) AS c
       FROM ai_feedback
      WHERE user_id = ? AND created_at >= ?
      GROUP BY day, action`,
  )
    .bind(userId, cutoff)
    .all<{ day: string; action: FeedbackAction; c: number }>();

  return buildFeedbackTrend(
    rows.results.map((r) => ({ day: r.day, action: r.action, count: Number(r.c) })),
    days,
  );
}

/* ------------------------------------------------------------------ *
 * Database access
 * ------------------------------------------------------------------ */

/**
 * Loads and aggregates the user's feedback history into a profile.
 *
 * Returns an empty profile (not null) when there is no history, so callers can
 * pass it straight into the engine without branching.
 *
 * Bounded to the most recent `FEEDBACK_PROFILE_LIMIT` rows: the profile feeds
 * per-tag accept/reject statistics, and recent feedback is what should steer
 * suggestions. Without a cap this query grew unboundedly with usage, loading
 * every feedback row a user ever produced into memory on each AI run.
 */
const FEEDBACK_PROFILE_LIMIT = 2000;

export async function loadFeedbackProfile(env: Env, userId: string): Promise<FeedbackProfile> {
  const rows = await env.DB.prepare(
    `SELECT tag_name, action, domain, final_tag_id, context
       FROM ai_feedback WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(userId, FEEDBACK_PROFILE_LIMIT)
    .all<Record<string, unknown>>();

  // B-22: only the three known actions may feed the profile. A dirty row with
  // any other value used to be coerced to 'accepted' (String(r.action ??
  // 'accepted')), silently inflating the accept side of the user's feedback
  // memory. Unknown values are dropped outright.
  const KNOWN_ACTIONS: ReadonlySet<string> = new Set(['accepted', 'rejected', 'modified']);
  return buildFeedbackProfile(
    rows.results
      .filter((r) => KNOWN_ACTIONS.has(String(r.action ?? '')))
      .map((r) => ({
        tagName: String(r.tag_name ?? ''),
        action: String(r.action) as FeedbackAction,
        domain: (r.domain as string | null) ?? null,
        finalTagId: (r.final_tag_id as string | null) ?? null,
        context: (r.context as string | null) ?? null,
      })),
  );
}

/** Writes feedback events in one batched statement group. */
export async function recordFeedback(
  env: Env,
  userId: string,
  records: FeedbackRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const ts = nowIso();
  const statements = records.map((rec) =>
    env.DB.prepare(
      `INSERT INTO ai_feedback
         (id, user_id, bookmark_id, tag_name, action, final_tag_id, source, confidence, domain, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(),
      userId,
      rec.bookmarkId,
      rec.tagName,
      rec.action,
      rec.finalTagId ?? null,
      rec.source ?? null,
      rec.confidence ?? null,
      rec.domain ?? null,
      rec.context ?? null,
      ts,
    ),
  );

  // D1 caps a single batch at 100 statements.
  const BATCH_LIMIT = 100;
  for (let i = 0; i < statements.length; i += BATCH_LIMIT) {
    await env.DB.batch(statements.slice(i, i + BATCH_LIMIT));
  }
}

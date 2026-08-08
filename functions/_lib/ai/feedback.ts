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

/** Host of a URL, lower-cased and stripped of a leading `www.`; null if unparseable. */
export function domainOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

/** Returns the user-preferred spelling for `name`, or `name` if none recorded. */
export function renameByFeedback(name: string, profile: FeedbackProfile): string {
  if (profile.modifiedTo.size === 0) return name;
  return profile.modifiedTo.get(normalizeKey(name)) ?? name;
}

/* ------------------------------------------------------------------ *
 * Database access
 * ------------------------------------------------------------------ */

/**
 * Loads and aggregates the user's feedback history into a profile.
 *
 * Returns an empty profile (not null) when there is no history, so callers can
 * pass it straight into the engine without branching.
 */
export async function loadFeedbackProfile(env: Env, userId: string): Promise<FeedbackProfile> {
  const rows = await env.DB.prepare(
    `SELECT tag_name, action, domain, final_tag_id, context
       FROM ai_feedback WHERE user_id = ?`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();

  return buildFeedbackProfile(
    rows.results.map((r) => ({
      tagName: String(r.tag_name ?? ''),
      action: String(r.action ?? 'accepted') as FeedbackAction,
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

import type { Env } from '../env';
import { loadConfigRow } from './config';
import type { AiContributionMetrics, AiUsageMetrics } from '../../../shared/types';

/**
 * Aggregate metrics for the AI organiser workbench.
 *
 * Two families, both derivable from tables we already write:
 *
 *   - `usage`       — *how often* the user drives bookmarks through the AI
 *                     organiser (frequency + coverage over the last 30 days).
 *   - `contribution`— *how much value* the AI delivers to the tag graph, as a
 *                     value-weighted share rather than a flat source ratio.
 *
 * The pure maths (`computeUsageRate` / `computeContribution`) are split out from
 * the DB calls so they can be unit-tested without a database, mirroring how
 * `feedback.ts` keeps `summarizeFeedback` pure.
 */

const USAGE_WINDOW_DAYS = 30;

/* ------------------------------------------------------------------ *
 * Pure maths (unit-testable, no DB)
 * ------------------------------------------------------------------ */

/** Adoption rate: distinct touched bookmarks / total bookmark pool. */
export function computeUsageRate(touched: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, touched / total);
}

export interface ContributionRaw {
  /** Accepted as proposed (model/taxonomy, not renamed). */
  direct: number;
  /** User renamed the proposal before accepting. */
  modified: number;
  /** Accepted but came from the domain-derived fallback engine. */
  fallback: number;
  /** Explicitly rejected proposals (excluded from the denominator). */
  rejected: number;
  /** Tag links with `source` that did not originate from a proposal. */
  userOnly: number;
}

/**
 * Turns the raw decision counts into the weighted contribution headline plus
 * the supporting numbers. Pure so the weighting model is trivially testable.
 *
 *   weighted = direct*1.0 + modified*0.6 + fallback*0.5   (AI value)
 *   total    = weighted + userOnly*1.0                    (all link value)
 *   rate     = total > 0 ? weighted / total : 0
 *
 * The denominator is value-weighted too: every tag link contributes its own
 * weight (user-only links count 1.0, the same as a direct AI link), so the
 * headline equals the AI slice of the stacked bar. Rejected proposals are
 * intentionally absent from both numerator and denominator — measuring AI
 * contribution on a base that includes what the user threw away would reward
 * noisy models.
 */
export function computeContribution(raw: ContributionRaw): AiContributionMetrics {
  const aiAccepted = raw.direct + raw.modified + raw.fallback;
  const weighted = raw.direct * 1.0 + raw.modified * 0.6 + raw.fallback * 0.5;
  const denom = weighted + raw.userOnly;
  const decided = aiAccepted + raw.rejected;

  return {
    weightedRate: denom > 0 ? weighted / denom : 0,
    directAi: raw.direct,
    assistedAi: raw.modified,
    fallbackAi: raw.fallback,
    userOnly: raw.userOnly,
    raw: {
      aiAccepted,
      modified: raw.modified,
      rejected: raw.rejected,
      fallbackAccepted: raw.fallback,
      userCreated: raw.userOnly,
    },
    hitRate: decided > 0 ? aiAccepted / decided : 0,
    acceptanceRate: decided > 0 ? aiAccepted / decided : 0,
  };
}

/* ------------------------------------------------------------------ *
 * DB-backed loaders
 * ------------------------------------------------------------------ */

interface JobScopeLike {
  target?: string;
  ids?: unknown;
}

function parseScope(raw: string | null): JobScopeLike | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as JobScopeLike;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function asIdList(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.filter((x): x is string => typeof x === 'string');
}

/**
 * Adoption + frequency metrics over the trailing 30-day window.
 *
 * `totalBookmarks` is passed in (it is already computed by the overview
 * endpoint's library-shape query) so we do not re-count the whole library here.
 */
export async function loadAiUsage(
  env: Env,
  userId: string,
  totalBookmarks: number,
): Promise<AiUsageMetrics> {
  const cutoff = new Date(Date.now() - USAGE_WINDOW_DAYS * 86_400_000).toISOString();

  const jobs = await env.DB.prepare(
    `SELECT id, status, engine, scope, total, created_at
       FROM ai_jobs
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at DESC`,
  )
    .bind(userId, cutoff)
    .all<{ id: string; status: string; engine: string | null; scope: string | null; total: number }>();

  // Distinct bookmarks touched in the window, each attributed to the scope of
  // the most recent run that included it (ORDER BY created_at DESC above makes
  // the last write in the map the freshest target — a clean partition).
  const touchedTarget = new Map<string, 'untagged' | 'all' | 'ids'>();
  // Which scope target each in-window job used, so bookmarks reached by
  // 'all'/'untagged' runs (whose scope carries no id list) can still be
  // attributed below. B-11: without this, whole-library runs — the largest
  // usage scenario — contributed zero touched bookmarks.
  const jobTarget = new Map<string, 'untagged' | 'all' | 'ids'>();
  const scopeJobCounts: Record<'untagged' | 'all' | 'ids', number> = {
    untagged: 0,
    all: 0,
    ids: 0,
  };
  const engineCounts: Record<'model' | 'fallback', number> = { model: 0, fallback: 0 };

  let runs = 0;
  let sizeSum = 0;

  for (const job of jobs.results) {
    if (job.status === 'cancelled') continue;
    runs += 1;
    sizeSum += Number(job.total ?? 0);

    const engine = (job.engine ?? 'fallback') as string;
    if (engine === 'model') engineCounts.model += 1;
    else engineCounts.fallback += 1; // 'fallback' | 'none' | null

    const scope = parseScope(job.scope);
    const target = (scope?.target === 'all' || scope?.target === 'ids'
      ? scope?.target
      : 'untagged') as 'untagged' | 'all' | 'ids';
    scopeJobCounts[target] += 1;
    jobTarget.set(job.id, target);

    for (const id of asIdList(scope?.ids)) {
      touchedTarget.set(id, target);
    }
  }

  // B-11: 'all'/'untagged' runs carry no id list, so attribute their touched
  // bookmarks through the suggestions they actually wrote in the window. This
  // also picks up one-off (job_id NULL) single-bookmark suggestions, treated
  // as 'ids' scope. Merging into the same map keeps ids-scoped bookmarks that
  // produced no suggestion counted, so this strictly widens — never narrows —
  // the touched set.
  const suggRows = await env.DB.prepare(
    `SELECT DISTINCT job_id, bookmark_id
       FROM tag_suggestions
      WHERE user_id = ? AND created_at >= ?`,
  )
    .bind(userId, cutoff)
    .all<{ job_id: string | null; bookmark_id: string }>();
  for (const s of suggRows.results) {
    const target = s.job_id ? jobTarget.get(s.job_id) : 'ids';
    if (target) touchedTarget.set(s.bookmark_id, target);
  }

  const touchedBookmarks = touchedTarget.size;

  // Suggestion funnel: accepted / rejected / pending, plus the auto-applied
  // share (accepted at or above the user's auto-apply threshold).
  const [statusRows, thresholdRow] = await Promise.all([
    env.DB.prepare(
      `SELECT status, COUNT(*) AS c FROM tag_suggestions WHERE user_id = ? GROUP BY status`,
    )
      .bind(userId)
      .all<{ status: string; c: number }>(),
    loadConfigRow(env, userId),
  ]);

  const byStatus = new Map(statusRows.results.map((r) => [String(r.status), Number(r.c)]));
  const accepted = byStatus.get('accepted') ?? 0;
  const rejected = byStatus.get('rejected') ?? 0;
  const pending = byStatus.get('pending') ?? 0;

  const autoRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM tag_suggestions
      WHERE user_id = ? AND status = 'accepted' AND confidence >= ?`,
  )
    .bind(userId, thresholdRow.autoApplyThreshold)
    .first<{ c: number }>();
  const autoApplied = Number(autoRow?.c ?? 0);

  return {
    adoptionRate: computeUsageRate(touchedBookmarks, totalBookmarks),
    touchedBookmarks,
    totalBookmarks,
    byScope: (['untagged', 'all', 'ids'] as const).map((target) => ({
      target,
      count: touchedTarget.size === 0 ? 0 : [...touchedTarget.values()].filter((t) => t === target).length,
    })),
    byEngine: (['model', 'fallback'] as const).map((engine) => ({
      engine,
      count: engineCounts[engine],
    })),
    runsLast30Days: runs,
    avgRunSize: runs > 0 ? sizeSum / runs : 0,
    suggestionOutcome: { accepted, rejected, pending, autoApplied },
  };
}

/**
 * Value-weighted AI contribution to the tag graph.
 *
 * Each *decided suggestion* is classified exactly once by joining to
 * `ai_feedback`: a rename records an `action = 'modified'` row (keyed by the
 * original bookmark + tag name), so a suggestion the user edited is detected via
 * an `EXISTS` and counted as assisted rather than direct. `source = 'fallback'`
 * marks the domain-derived fallback proposals. Rejected rows are counted for
 * the hit rate but excluded from the contribution denominator.
 *
 * `userTagLinks` (the existing provenance split) fills in the user-only base.
 */
export async function loadAiContribution(
  env: Env,
  userId: string,
  userTagLinks: number,
): Promise<AiContributionMetrics> {
  // Map bookmark privacy through the shared clause so trashed / private-hidden
  // bookmarks never inflate either side of the contribution split.
  const row = await env.DB.prepare(
    `WITH base AS (
       SELECT s.status AS status, s.source AS source,
              EXISTS (
                SELECT 1 FROM ai_feedback f
                WHERE f.user_id = s.user_id
                  AND f.bookmark_id = s.bookmark_id
                  AND f.tag_name = s.tag_name
                  AND f.action = 'modified'
              ) AS is_mod
       FROM tag_suggestions s
       WHERE s.user_id = ?
     )
     SELECT
       SUM(CASE WHEN status = 'accepted' AND is_mod THEN 1 ELSE 0 END) AS modified,
       SUM(CASE WHEN status = 'accepted' AND NOT is_mod AND source = 'fallback' THEN 1 ELSE 0 END) AS fallback,
       SUM(CASE WHEN status = 'accepted' AND NOT is_mod AND source <> 'fallback' THEN 1 ELSE 0 END) AS direct,
       SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
       SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
     FROM base`,
  )
    .bind(userId)
    .first<{ modified: number; fallback: number; direct: number; accepted: number; rejected: number }>();

  const num = (v: number | null | undefined): number => Number(v ?? 0);

  return computeContribution({
    direct: num(row?.direct),
    modified: num(row?.modified),
    fallback: num(row?.fallback),
    rejected: num(row?.rejected),
    userOnly: Math.max(0, userTagLinks),
  });
}

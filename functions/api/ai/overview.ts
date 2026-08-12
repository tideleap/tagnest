import type { AiOverview } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import {
  countPending,
  isModelReady,
  listJobs,
  loadConfigRow,
  loadFeedbackMetrics,
  loadFeedbackTrend,
  toApiJob,
} from '../../_lib/ai';
import { PROMPT_VERSION } from '../../_lib/ai/prompt';
import { PRIVATE_BOOKMARK_CLAUSE } from '../../_lib/db';

/**
 * Numbers for the organiser workbench.
 *
 * The interesting pair is `aiTagLinks` / `userTagLinks`. Before the refactor
 * "how much is the AI actually contributing?" was unanswerable — tags carried
 * no provenance, so a model-written tag and a hand-typed one were the same
 * row. The `source` column added in migration 0006 makes the contribution a
 * measurable number, which is the only honest way to judge whether raising the
 * model's weight in the pipeline actually helped.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  const [row, pending, jobs, counts, provenance, feedback, trend] = await Promise.all([
    loadConfigRow(ctx.env, userId),
    countPending(ctx.env, userId),
    listJobs(ctx.env, userId, 5),

    // Library shape: how much is left to organise.
    ctx.env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN NOT EXISTS (
           SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id
         ) THEN 1 ELSE 0 END) AS untagged
       FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}`,
    )
      .bind(userId)
      .first<{ total: number; untagged: number }>(),

    // Provenance split. Joined through bookmarks so trashed items do not
    // inflate either side.
    ctx.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN bt.source = 'ai' THEN 1 ELSE 0 END) AS ai,
         SUM(CASE WHEN bt.source IS NULL OR bt.source <> 'ai' THEN 1 ELSE 0 END) AS user_made
       FROM bookmark_tags bt
       JOIN bookmarks b ON b.id = bt.bookmark_id AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
      WHERE b.user_id = ?`,
    )
      .bind(userId)
      .first<{ ai: number; user_made: number }>(),

    // Phase 5: suggestion-quality metrics from the feedback loop.
    loadFeedbackMetrics(ctx.env, userId),
    loadFeedbackTrend(ctx.env, userId, 30),
  ]);

  const overview: AiOverview = {
    modelReady: isModelReady(row),
    heuristicsEnabled: row.heuristicsEnabled,
    pendingSuggestions: pending,
    untaggedBookmarks: Number(counts?.untagged ?? 0),
    totalBookmarks: Number(counts?.total ?? 0),
    aiTagLinks: Number(provenance?.ai ?? 0),
    userTagLinks: Number(provenance?.user_made ?? 0),
    recentJobs: jobs.map(toApiJob),
    feedback,
    feedbackTrend: trend,
    promptVersion: PROMPT_VERSION,
  };

  return json(overview);
};

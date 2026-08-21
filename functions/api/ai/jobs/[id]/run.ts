import type { AiJobRunResult, AutoGroupResult } from '../../../../../shared/types';
import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { conflict, json, notFound } from '../../../../_lib/http';
import { createLogger } from '../../../../_lib/logger';
import {
  RUN_CHUNK,
  autoApply,
  aggregateTopics,
  applyTagHierarchy,
  countJobNewTags,
  getJob,
  loadAiConfig,
  loadBookmarkInputs,
  loadConfigRow,
  loadFeedbackProfile,
  loadFewShotExamples,
  loadVocabulary,
  makeKvTagCache,
  saveSuggestions,
  shouldWarnRebalance,
  suggestForBookmarks,
  toApiJob,
  toLocalConfig,
  updateJob,
} from '../../../../_lib/ai';

/**
 * Processes the next chunk of a run.
 *
 * The client calls this in a loop until `done` comes back true, rendering
 * progress from the returned job between calls. Each call is a normal, short
 * request — no streaming, no worker that outlives the connection, no queue
 * infrastructure. On Pages that is the only shape that is actually reliable.
 *
 * ## Why the client drives the loop
 *
 * `waitUntil` would let the server keep working after responding, but there is
 * then no way to report progress, resume, or stop. Handing each chunk back to
 * the client costs one round trip per 20 bookmarks and buys live progress,
 * cancellation, and a run that survives a reload.
 *
 * ## Failure policy
 *
 * A model failure is not a job failure. `suggestForBookmarks` degrades to the
 * domain-derived fallback and reports why; the chunk still produces proposals
 * and the run continues. Only a *fatal* condition (bad key, unknown model —
 * things a retry cannot fix) stops the run, because otherwise every remaining
 * chunk would burn a round trip to fail the same way.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const jobId = String(ctx.params.id);
  const log = createLogger(ctx.env);

  const job = await getJob(ctx.env, userId, jobId);
  if (!job) throw notFound('整理任务不存在');

  if (job.status === 'cancelled') throw conflict('该整理任务已取消');
  if (job.status === 'failed') throw conflict(job.error ?? '该整理任务已失败');

  const ids = job.scope?.ids ?? [];
  const slice = ids.slice(job.processed, job.processed + RUN_CHUNK);

  // Nothing left: settle the job and tell the client to stop looping.
  if (slice.length === 0) {
    if (job.status !== 'done') await updateJob(ctx.env, userId, jobId, { status: 'done' });
    const settled = await getJob(ctx.env, userId, jobId);
    const result: AiJobRunResult = {
      job: toApiJob(settled ?? { ...job, status: 'done' }),
      done: true,
      suggested: 0,
      autoApplied: 0,
      rebalanceWarning: false,
      uncovered: 0,
      engine: 'none',
      modelError: null,
    };
    return json(result);
  }

  if (job.status === 'queued') await updateJob(ctx.env, userId, jobId, { status: 'running' });

  // Config is re-read per chunk on purpose: changing the model or the tag
  // budget mid-run takes effect on the next chunk instead of being frozen at
  // job creation.
  const row = await loadConfigRow(ctx.env, userId);
  const local = toLocalConfig(row);
  const config = await loadAiConfig(ctx.env, userId);

  // Vocabulary is also re-read per chunk, so tags accepted from the previous
  // chunk are already part of the taxonomy the next chunk normalises against.
  // That is what stops a long run from inventing "前端" and "Frontend" in two
  // different chunks of the same job.
  const vocab = await loadVocabulary(ctx.env, userId);
  // Load the user's accept/reject history so this chunk's proposals are bent by
  // what they have accepted or rejected before (the "越用越准" loop).
  const feedback = await loadFeedbackProfile(ctx.env, userId);

  const inputs = await loadBookmarkInputs(ctx.env, userId, slice);
  // Anything that vanished between snapshot and now (trashed, deleted) counts
  // as processed-but-failed rather than silently shrinking the total.
  const missing = slice.length - inputs.length;

  // 方案B: few-shot examples from the user's own well-tagged bookmarks. Loaded
  // once per chunk (cheap, capped at 4 rows) so a long run keeps teaching the
  // model the user's style on every batch.
  const examples = (await loadFewShotExamples(ctx.env, userId)).map((row) => ({
    title: row.title,
    url: row.url,
    description: row.description ?? undefined,
    tags: row.tags.map((name) => ({ name, reason: '用户已标注' })),
  }));

  const outcome = await suggestForBookmarks(inputs, {
    vocab,
    config,
    local,
    feedback,
    examples,
    tagCache: ctx.env.AI_CACHE ? makeKvTagCache(ctx.env.AI_CACHE) : undefined,
  });

  const written = await saveSuggestions(ctx.env, userId, jobId, outcome.results);
  const autoApplied = await autoApply(ctx.env, userId, local.autoApplyThreshold, jobId);

  const processed = job.processed + slice.length;
  const finished = processed >= ids.length;
  const failed = Boolean(outcome.fatal);

  await updateJob(ctx.env, userId, jobId, {
    processed,
    suggested: job.suggested + written,
    failed: job.failed + missing,
    engine: outcome.engine,
    status: failed ? 'failed' : finished ? 'done' : 'running',
    error: failed ? outcome.modelError : null,
  });

  // Synchronize the three-level hierarchy with the organization run.
  // Only runs when the chunk finishes successfully so partial failures do not
  // leave the tag tree in a half-rewritten state.
  let autoGrouped: AutoGroupResult | undefined;
  if (finished && !failed) {
    try {
      autoGrouped = await applyTagHierarchy(ctx.env.DB, userId);
    } catch (e) {
      log.error('ai.job.grouping', {
        userId,
        jobId,
        error: e instanceof Error ? e.message : String(e),
      });
      // Grouping failure is not fatal to the run: proposals are already saved.
    }
  }

  log.info('ai.job.chunk', {
    userId,
    jobId,
    processed,
    total: ids.length,
    suggested: written,
    autoApplied,
    autoGrouped: autoGrouped
      ? { created: autoGrouped.createdCategories, relocated: autoGrouped.relocated }
      : null,
    engine: outcome.engine,
    fatal: outcome.fatal,
  });

  const updated = await getJob(ctx.env, userId, jobId);

  // P2-2: on a successful finish, measure how much NEW taxonomy this run
  // introduced relative to what already existed. A large share means the
  // incremental pass drifted, so the UI suggests a full re-classify.
  let rebalanceWarning = false;
  if (finished && !failed) {
    try {
      const { newTags, existingTags } = await countJobNewTags(ctx.env, userId, jobId);
      rebalanceWarning = shouldWarnRebalance(newTags, existingTags);
    } catch (e) {
      // A warning is advisory; never let its computation fail the run.
      log.error('ai.job.rebalance', {
        userId,
        jobId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const result: AiJobRunResult = {
    job: toApiJob(updated ?? job),
    done: finished || failed,
    suggested: written,
    autoApplied,
    rebalanceWarning,
    uncovered: outcome.uncovered,
    engine: outcome.engine,
    modelError: outcome.modelError,
    topics: aggregateTopics(outcome.results),
    autoGrouped,
  };

  return json(result);
};

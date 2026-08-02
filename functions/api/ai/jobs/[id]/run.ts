import type { AiJobRunResult } from '../../../../../shared/types';
import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { conflict, json, notFound } from '../../../../_lib/http';
import { createLogger } from '../../../../_lib/logger';
import {
  RUN_CHUNK,
  autoApply,
  getJob,
  loadAiConfig,
  loadBookmarkInputs,
  loadConfigRow,
  loadVocabulary,
  saveSuggestions,
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
 * local heuristics and reports why; the chunk still produces proposals and the
 * run continues. Only a *fatal* condition (bad key, unknown model — things a
 * retry cannot fix) stops the run, because otherwise every remaining chunk
 * would burn a round trip to fail the same way.
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
    if (job.status !== 'done') await updateJob(ctx.env, jobId, { status: 'done' });
    const settled = await getJob(ctx.env, userId, jobId);
    const result: AiJobRunResult = {
      job: toApiJob(settled ?? { ...job, status: 'done' }),
      done: true,
      suggested: 0,
      autoApplied: 0,
      engine: 'none',
      modelError: null,
    };
    return json(result);
  }

  if (job.status === 'queued') await updateJob(ctx.env, jobId, { status: 'running' });

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

  const inputs = await loadBookmarkInputs(ctx.env, userId, slice);
  // Anything that vanished between snapshot and now (trashed, deleted) counts
  // as processed-but-failed rather than silently shrinking the total.
  const missing = slice.length - inputs.length;

  const outcome = await suggestForBookmarks(inputs, { vocab, config, local });

  const written = await saveSuggestions(ctx.env, userId, jobId, outcome.results);
  const autoApplied = await autoApply(ctx.env, userId, local.autoApplyThreshold, jobId);

  const processed = job.processed + slice.length;
  const finished = processed >= ids.length;

  await updateJob(ctx.env, jobId, {
    processed,
    suggested: job.suggested + written,
    failed: job.failed + missing,
    engine: outcome.engine,
    status: outcome.fatal ? 'failed' : finished ? 'done' : 'running',
    error: outcome.fatal ? outcome.modelError : null,
  });

  log.info('ai.job.chunk', {
    userId,
    jobId,
    processed,
    total: ids.length,
    suggested: written,
    autoApplied,
    engine: outcome.engine,
    fatal: outcome.fatal,
  });

  const updated = await getJob(ctx.env, userId, jobId);
  const result: AiJobRunResult = {
    job: toApiJob(updated ?? job),
    done: finished || outcome.fatal,
    suggested: written,
    autoApplied,
    engine: outcome.engine,
    modelError: outcome.modelError,
  };

  return json(result);
};

import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { conflict, json, notFound } from '../../../../_lib/http';
import { createLogger } from '../../../../_lib/logger';
import { getJob, toApiJob, undoJob } from '../../../../_lib/ai';

/**
 * Undoes one run's accepted work (plan T2 "可撤销").
 *
 * Removes the `source = 'ai'` tag links the run's accepted suggestions wrote,
 * and puts those suggestions back into the review queue. User-applied tags are
 * never touched — provenance (migration 0006) is what makes this safe.
 *
 * Only settled runs are undoable: undoing a queued/running job would race the
 * chunk loop that is still writing suggestions, so an active run must be
 * cancelled (or finish) first.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const jobId = String(ctx.params.id);
  const log = createLogger(ctx.env);

  const job = await getJob(ctx.env, userId, jobId);
  if (!job) throw notFound('整理任务不存在');

  if (job.status === 'queued' || job.status === 'running') {
    throw conflict('任务还在进行中，请先停止或等它完成，再撤销');
  }

  const outcome = await undoJob(ctx.env, userId, jobId);

  log.info('ai.job.undo', {
    userId,
    jobId,
    removedLinks: outcome.removedLinks,
    restoredSuggestions: outcome.restoredSuggestions,
    droppedSuggestions: outcome.droppedSuggestions,
  });

  const updated = await getJob(ctx.env, userId, jobId);
  return json({ job: toApiJob(updated ?? job), ...outcome });
};

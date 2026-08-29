import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { conflict, json, notFound } from '../../../../_lib/http';
import { createLogger } from '../../../../_lib/logger';
import { getJob, toApiJob, undoCategorizeJob, undoJob, undoRenameJob } from '../../../../_lib/ai';

/**
 * Undoes one run's accepted work (plan T2 "可撤销").
 *
 * Removes the `source = 'ai'` writes the run's accepted suggestions produced,
 * and puts those suggestions back into the review queue. User-applied data is
 * never touched — provenance (migration 0006 / 0024) is what makes this safe.
 *
 * The three job kinds undo differently:
 *  - `tagging`    → deletes `bookmark_tags` links (`undoJob`);
 *  - `categorize` → deletes `bookmark_primary_category` placements
 *                   (`undoCategorizeJob`). Manual / browser-folder placements
 *                   survive because the delete is scoped to `source='ai'` + job id;
 *  - `rename`     → restores `bookmarks.title` from the original recorded in
 *                   each accepted suggestion (`undoRenameJob`), only when the
 *                   live title still matches what accept wrote.
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

  if (job.kind === 'rename') {
    const outcome = await undoRenameJob(ctx.env, userId, jobId);
    log.info('ai.job.undo', {
      userId,
      jobId,
      kind: 'rename',
      restoredTitles: outcome.restoredTitles,
      restoredSuggestions: outcome.restoredSuggestions,
    });
    const updated = await getJob(ctx.env, userId, jobId);
    return json({ job: toApiJob(updated ?? job), ...outcome });
  }

  if (job.kind === 'categorize') {
    const outcome = await undoCategorizeJob(ctx.env, userId, jobId);
    log.info('ai.job.undo', {
      userId,
      jobId,
      kind: 'categorize',
      removedPlacements: outcome.removedPlacements,
      restoredSuggestions: outcome.restoredSuggestions,
    });
    const updated = await getJob(ctx.env, userId, jobId);
    return json({ job: toApiJob(updated ?? job), ...outcome });
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

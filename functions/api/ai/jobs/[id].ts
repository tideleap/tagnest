import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { json, notFound } from '../../../_lib/http';
import { getJob, toApiJob, updateJob } from '../../../_lib/ai';

/**
 * Progress for one run, plus cancellation.
 *
 * The client polls `GET` between chunks so progress survives a reload: the
 * counters live in the database, not in a React state variable, so closing the
 * tab mid-run and coming back shows exactly where it stopped.
 */

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const job = await getJob(ctx.env, userId, String(ctx.params.id));
  if (!job) throw notFound('整理任务不存在');
  return json({ job: toApiJob(job) });
};

/**
 * Cancels a run.
 *
 * Suggestions already written stay in the queue — they are perfectly good
 * proposals, and throwing away completed work because the user stopped early
 * would be the wrong call.
 */
export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const jobId = String(ctx.params.id);

  const job = await getJob(ctx.env, userId, jobId);
  if (!job) throw notFound('整理任务不存在');

  if (job.status === 'queued' || job.status === 'running') {
    await updateJob(ctx.env, jobId, { status: 'cancelled' });
  }

  const updated = await getJob(ctx.env, userId, jobId);
  return json({ job: toApiJob(updated ?? job) });
};

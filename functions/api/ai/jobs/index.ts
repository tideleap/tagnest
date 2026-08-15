import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, badRequestCode, json, readJson } from '../../../_lib/http';
import { MAX_JOB_ITEMS, createJob, listJobs, resolveScope, toApiJob } from '../../../_lib/ai';
import { PROMPT_VERSION } from '../../../_lib/ai/prompt';

/**
 * Batch organiser runs.
 *
 * `POST` starts a run, `GET` lists recent ones.
 *
 * ## Why a job rather than "tag everything in one request"
 *
 * Tagging a library of a few thousand bookmarks is minutes of model calls —
 * far past any single request budget, and a dropped connection halfway would
 * lose the lot. Creating the job only *snapshots the scope*; the work happens
 * in `POST /api/ai/jobs/:id/run`, one chunk per call, driven by the client.
 * That gives real progress, a resumable run, and no long-lived request.
 *
 * This endpoint is the difference between AI tagging being a per-save
 * side-effect (what it was) and a first-class bulk operation the user can
 * point at their whole library (what the refactor makes it).
 */

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const jobs = await listJobs(ctx.env, userId, 10);
  return json({ jobs: jobs.map(toApiJob) });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ target?: unknown; bookmarkIds?: unknown; limit?: unknown }>(
    ctx.request,
  );

  const target = String(body.target ?? 'untagged');
  if (target !== 'untagged' && target !== 'all' && target !== 'ids') {
    throw badRequest('整理范围无效');
  }

  const explicitIds = Array.isArray(body.bookmarkIds)
    ? [...new Set(body.bookmarkIds.map(String))].filter(Boolean).slice(0, MAX_JOB_ITEMS)
    : [];

  if (target === 'ids' && explicitIds.length === 0) {
    throw badRequest('请选择要整理的书签');
  }

  // Trial run (plan T2): `limit` clips the snapshot to the first N bookmarks,
  // so the user can sample a big library ("先试 20 条") before committing the
  // whole thing. The rest of the pipeline is untouched — a trial is a normal
  // job with a smaller scope, which is exactly what makes it resumable,
  // cancellable and undoable like any other run.
  const rawLimit = Number(body.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.trunc(rawLimit), MAX_JOB_ITEMS)
      : null;

  let ids = await resolveScope(ctx.env, userId, target, explicitIds);
  if (limit !== null) ids = ids.slice(0, limit);

  // An empty scope is a dead end, not something a retry fixes — say which case
  // it is so the UI can explain rather than show a generic failure.
  if (ids.length === 0) {
    throw badRequestCode(
      'ai_scope_empty',
      target === 'untagged' ? '没有待整理的书签，全部书签都已有标签' : '所选范围内没有可整理的书签',
    );
  }

  const job = await createJob(ctx.env, userId, 'tagging', { target, ids }, PROMPT_VERSION);
  return json({ job: toApiJob(job) }, { status: 201 });
};

import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, badRequestCode, json, readJson } from '../../../_lib/http';
import {
  MAX_JOB_ITEMS,
  createJob,
  listJobs,
  resolveCategorizeScope,
  resolveScope,
  toApiJob,
} from '../../../_lib/ai';
import { CATEGORIZE_PROMPT_VERSION, PROMPT_VERSION, RENAME_PROMPT_VERSION } from '../../../_lib/ai/prompt';

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
  const body = await readJson<{
    target?: unknown;
    bookmarkIds?: unknown;
    limit?: unknown;
    kind?: unknown;
    includeBrowserFolder?: unknown;
  }>(ctx.request);

  // CategorySync: `kind` selects the organiser track. 'tagging' (default) keeps
  // the legacy loose-label behaviour; 'categorize' runs the single-placement
  // pipeline (PRD §5.1 — reuses this endpoint rather than a new /api/ai/categorize).
  // Rename mode (Phase B) adds 'rename': conservative title cleanup.
  const kind = String(body.kind ?? 'tagging');
  if (kind !== 'tagging' && kind !== 'categorize' && kind !== 'rename') {
    throw badRequest('任务类型无效');
  }

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

  let ids: string[];
  if (kind === 'categorize') {
    // Categorize scope differs deliberately (PRD §10-6): bookmarks holding a
    // browser_folder placement are skipped unless the caller opts in, and
    // `untagged` means "no primary category yet".
    const includeBrowserFolder = body.includeBrowserFolder === true;
    ids = await resolveCategorizeScope(ctx.env, userId, target, explicitIds, includeBrowserFolder);
  } else if (kind === 'rename') {
    // Rename scope: every live bookmark is fair game — a title can need
    // cleanup regardless of whether it has tags or a placement. Private
    // bookmarks stay excluded by the shared clause inside `resolveScope`.
    ids = await resolveScope(ctx.env, userId, target === 'untagged' ? 'all' : target, explicitIds);
  } else {
    ids = await resolveScope(ctx.env, userId, target, explicitIds);
  }
  if (limit !== null) ids = ids.slice(0, limit);

  // An empty scope is a dead end, not something a retry fixes — say which case
  // it is so the UI can explain rather than show a generic failure.
  if (ids.length === 0) {
    const scopeHint =
      kind === 'rename'
        ? '所选范围内没有可清理命名的书签'
        : kind === 'categorize'
          ? target === 'untagged'
            ? '没有待分类的书签，全部书签都已有主分类'
            : '所选范围内没有可分类的书签'
          : target === 'untagged'
            ? '没有待整理的书签，全部书签都已有标签'
            : '所选范围内没有可整理的书签';
    throw badRequestCode('ai_scope_empty', scopeHint);
  }

  const promptVersion =
    kind === 'categorize'
      ? CATEGORIZE_PROMPT_VERSION
      : kind === 'rename'
        ? RENAME_PROMPT_VERSION
        : PROMPT_VERSION;
  const job = await createJob(ctx.env, userId, kind, { target, ids }, promptVersion);
  return json({ job: toApiJob(job) }, { status: 201 });
};

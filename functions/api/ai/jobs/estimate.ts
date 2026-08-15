import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json } from '../../../_lib/http';
import { MAX_JOB_ITEMS, estimateJob } from '../../../_lib/ai';

/**
 * Cost forecast for a batch run — the "how much will this cost before I press
 * start" endpoint (plan A1/T2).
 *
 * Pure computation: it resolves the scope and measures one sample prompt, but
 * never calls a model, so it is free and safe to fetch on every scope change.
 *
 * Query params mirror `POST /api/ai/jobs`:
 *   `target`  'untagged' | 'all' | 'ids' (default 'untagged')
 *   `ids`     comma-separated bookmark ids, required when target=ids
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const url = new URL(ctx.request.url);

  const target = String(url.searchParams.get('target') ?? 'untagged');
  if (target !== 'untagged' && target !== 'all' && target !== 'ids') {
    throw badRequest('整理范围无效');
  }

  const explicitIds =
    target === 'ids'
      ? [...new Set(String(url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()))]
          .filter(Boolean)
          .slice(0, MAX_JOB_ITEMS)
      : [];

  if (target === 'ids' && explicitIds.length === 0) {
    throw badRequest('请选择要整理的书签');
  }

  const estimate = await estimateJob(ctx.env, userId, target, explicitIds);
  return json({ estimate });
};

import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { json } from '../../../_lib/http';
import { estimateJob, parseJobScopeParams } from '../../../_lib/ai';

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
 *   `kind`    'tagging' (default) | 'categorize' | 'rename' — per-track scope
 *             rules (rename runs every live bookmark, same as tagging)
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const url = new URL(ctx.request.url);

  // C-5: 与 POST /api/ai/jobs 共用同一份范围校验（_lib/ai/job-params.ts），
  // 保证预估算的范围和真实任务算的范围永远一致。预估是只读的，非法 kind 沿用
  // 历史行为静默回落到 tagging（strictKind 不开）。
  const { target, kind, ids: explicitIds } = parseJobScopeParams({
    target: url.searchParams.get('target'),
    kind: url.searchParams.get('kind'),
    ids: url.searchParams.get('ids'),
  });

  const estimate = await estimateJob(ctx.env, userId, target, explicitIds, kind);
  return json({ estimate });
};

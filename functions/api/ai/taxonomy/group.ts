import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { json } from '../../../_lib/http';
import { applyTagHierarchy } from '../../../_lib/ai/grouping-apply';

/**
 * Applies the automatic three-level hierarchy ("自动建组") to the user's tags.
 *
 * Delegates to `applyTagHierarchy` so the same logic can be triggered
 * automatically at the end of an AI organization run.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const result = await applyTagHierarchy(ctx.env.DB, userId);
  return json(result);
};

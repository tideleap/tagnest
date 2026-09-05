import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, readJson } from '../../../_lib/http';
import { applyTagHierarchy } from '../../../_lib/ai/grouping-apply';
import type { GroupingOptions } from '../../../_lib/ai/grouping';

/**
 * Applies the automatic three-level hierarchy ("自动建组") to the user's tags.
 *
 * Delegates to `applyTagHierarchy` so the same logic can be triggered
 * automatically at the end of an AI organization run.
 *
 * Orphan governance (2026-09-05): consolidation is ON by default. The body
 * may tune it:
 *   - `{}` / omitted            → default governance (minTagCount 2, maxOrphans 20, 「其他」)
 *   - `{ "minTagCount": 3, "maxOrphans": 10, "defaultGroup": "未分类" }`
 *                               → caller-tuned governance (each field optional)
 *   - `{ "legacy": true }`      → legacy conservative pass, no consolidation
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  let options: GroupingOptions | null | undefined;
  if (body.legacy === true) {
    options = null; // explicit opt-out → pre-governance behaviour
  } else if (body.legacy !== undefined) {
    throw badRequest('legacy 必须是布尔值');
  } else if (
    body.minTagCount !== undefined ||
    body.maxOrphans !== undefined ||
    body.defaultGroup !== undefined
  ) {
    options = parseGroupingOptions(body);
  }
  // else: undefined → applyTagHierarchy applies the default governance.

  const result = await applyTagHierarchy(ctx.env.DB, userId, options);
  return json(result);
};

/** Validates the three knobs so a malformed body fails fast with a 400. */
function parseGroupingOptions(body: Record<string, unknown>): GroupingOptions {
  const opts: GroupingOptions = {};
  if (body.minTagCount !== undefined) {
    const n = Number(body.minTagCount);
    if (!Number.isInteger(n) || n < 1) throw badRequest('minTagCount 必须是 ≥1 的整数');
    opts.minTagCount = n;
  }
  if (body.maxOrphans !== undefined) {
    const n = Number(body.maxOrphans);
    if (!Number.isInteger(n) || n < 0) throw badRequest('maxOrphans 必须是 ≥0 的整数');
    opts.maxOrphans = n;
  }
  if (body.defaultGroup !== undefined) {
    if (typeof body.defaultGroup !== 'string' || body.defaultGroup.trim() === '') {
      throw badRequest('defaultGroup 必须是非空字符串');
    }
    opts.defaultGroup = body.defaultGroup.trim();
  }
  return opts;
}

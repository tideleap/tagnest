import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json, badRequest } from '../../_lib/http';
import { createLogger } from '../../_lib/logger';
import {
  classifyApply,
  classifyReport,
  classifyRevert,
} from '../../_lib/ai/classify-apply';
import { DEFAULT_CLASSIFY_OPTIONS } from '../../_lib/ai/classifier';
import type { ClassifyRequest, ClassifyResponse, ClassifyScope } from '../../../shared/types';

/**
 * POST /api/ai/classify — three-level ML classification of bookmarks.
 *
 * Body: { mode?, scope?, confidenceThreshold? }
 *   mode:  'report' (default) | 'apply' | 'revert'
 *   scope: { type: 'all'|'untagged'|'ids', ids?: string[] }
 *
 * - report: classify a scope and return the structured result. Read-only.
 * - apply:  link auto-filed bookmarks to their 一级/二级 tags (idempotent).
 * - revert: remove those links (deterministic inverse of apply).
 *
 * Confidence threshold (default 0.6) is forwarded to the model; below it an
 * item is flagged `needsReview` and never written into the hierarchy.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const log = createLogger(ctx.env);

  let body: ClassifyRequest = {};
  try {
    const raw = await ctx.request.json<ClassifyRequest>();
    if (raw && typeof raw === 'object') body = raw;
  } catch {
    // empty / non-JSON body → defaults
  }

  const mode = body.mode ?? 'report';
  if (!['report', 'apply', 'revert'].includes(mode)) {
    throw badRequest('mode 必须是 report | apply | revert');
  }

  const scope: ClassifyScope = body.scope ?? { type: 'all' };
  if (!['all', 'untagged', 'ids'].includes(scope.type)) {
    throw badRequest('scope.type 必须是 all | untagged | ids');
  }
  if (scope.type === 'ids' && (!scope.ids || scope.ids.length === 0)) {
    throw badRequest('scope.type=ids 时必须提供 ids');
  }

  const threshold =
    typeof body.confidenceThreshold === 'number' && body.confidenceThreshold >= 0 && body.confidenceThreshold <= 1
      ? body.confidenceThreshold
      : DEFAULT_CLASSIFY_OPTIONS.confidenceThreshold;

  try {
    if (mode === 'apply') {
      const { result, linksCreated } = await classifyApply(ctx.env, userId, scope, {
        confidenceThreshold: threshold,
      });
      const resp: ClassifyResponse = {
        mode,
        scope,
        confidenceThreshold: threshold,
        summary: {
          total: result.total,
          classified: result.classified,
          needsReview: result.needsReview,
          quarantined: result.quarantined,
          avgConfidence: result.avgConfidence,
        },
        byCategory: result.byCategory,
        predictions: result.predictions,
        linksCreated,
      };
      log.info('ai.classify.apply', { userId, scope: scope.type, linksCreated, ...resp.summary });
      return json(resp);
    }

    if (mode === 'revert') {
      const { result, linksRemoved } = await classifyRevert(ctx.env, userId, scope, {
        confidenceThreshold: threshold,
      });
      const resp: ClassifyResponse = {
        mode,
        scope,
        confidenceThreshold: threshold,
        summary: {
          total: result.total,
          classified: result.classified,
          needsReview: result.needsReview,
          quarantined: result.quarantined,
          avgConfidence: result.avgConfidence,
        },
        byCategory: result.byCategory,
        predictions: result.predictions,
        linksRemoved,
      };
      log.info('ai.classify.revert', { userId, scope: scope.type, linksRemoved });
      return json(resp);
    }

    // default: report
    const result = await classifyReport(ctx.env, userId, scope, { confidenceThreshold: threshold });
    const resp: ClassifyResponse = {
      mode,
      scope,
      confidenceThreshold: threshold,
      summary: {
        total: result.total,
        classified: result.classified,
        needsReview: result.needsReview,
        quarantined: result.quarantined,
        avgConfidence: result.avgConfidence,
      },
      byCategory: result.byCategory,
      predictions: result.predictions,
    };
    log.info('ai.classify.report', { userId, scope: scope.type, ...resp.summary });
    return json(resp);
  } catch (error) {
    log.error('ai.classify.failed', {
      userId,
      mode,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

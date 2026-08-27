import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { ApiException, badRequest, forbidden, json, readJson } from '../../_lib/http';
import { grantProTrial, requireAdmin } from '../../_lib/ai';
import type { GrantTrialRequest, GrantTrialResponse } from '../../../shared/types';

/**
 * `POST /api/admin/grant-pro-trial`
 *
 * Operator-only: hands a user a Pro/Team trial (seeds credits + sets the
 * subscription to `trialing`). There is no `users.role` column in this
 * self-hosted product, so the gate is the instance's `ADMIN_TOKEN` secret
 * (see `_lib/ai/billing.ts#requireAdmin`). A logged-in user must still present
 * it; without it the endpoint refuses rather than silently doing nothing.
 *
 * When `ADMIN_TOKEN` is unset on the instance the whole admin surface is
 * meaningfully closed: we answer 503 so a misconfigured deploy never exposes
 * an open grant path, and 403 (with a precise message) when a token was
 * presented but did not match.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  // The caller must be a logged-in user; the real authorization is the token.
  requireUserId(ctx);

  if (!ctx.env.ADMIN_TOKEN) {
    throw new ApiException(503, 'admin_disabled', '实例未启用管理员接口（ADMIN_TOKEN 未配置）');
  }
  if (!requireAdmin(ctx.env, ctx.request)) {
    throw forbidden('管理员令牌无效');
  }

  const body = await readJson<GrantTrialRequest>(ctx.request);
  if (!body.email || !String(body.email).trim()) {
    throw badRequest('请提供要发放试用的用户邮箱');
  }

  try {
    const result = await grantProTrial(ctx.env, body.email, {
      plan: body.plan,
      credits: body.credits,
      days: body.days,
    });
    return json(result as GrantTrialResponse);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : '发放试用失败');
  }
};

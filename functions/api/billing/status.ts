import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import { getBillingStatus } from '../../_lib/ai';

/**
 * `GET /api/billing/status`
 *
 * The settings page's single source of truth for plan + credit state. Returns
 * the `BillingInfo` shape: plan, subscription status, whether this instance
 * serves a hosted model, the user's consent flag, and the live credit meter.
 *
 * Free / BYO-key deployments get the honest answer (plan 'free', balance 0,
 * managedAvailable false) rather than an error — the UI renders the meter only
 * when `managedAvailable` is true, so a self-hosted instance shows nothing it
 * cannot deliver.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const info = await getBillingStatus(ctx.env, userId);
  return json(info);
};

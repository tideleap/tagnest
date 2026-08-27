import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingInfo, GrantTrialRequest, GrantTrialResponse } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

/**
 * Plan + credit meter for the settings page.
 *
 * `retry: false` on purpose: a 503 here means the instance has no billing
 * surface configured, and hammering it changes nothing. The UI renders a
 * quiet "self-hosted" state instead of a spinner.
 */
export function useBillingStatus() {
  return useQuery({
    queryKey: keys.billing,
    queryFn: () => api.get<BillingInfo>('/billing/status'),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Operator tool: grant a Pro/Team trial to a user by email. The admin token is
 * typed into the form each time (never persisted) and sent as `x-admin-token`.
 */
export function useGrantProTrial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ token, ...body }: GrantTrialRequest & { token: string }) =>
      api.post<GrantTrialResponse>('/admin/grant-pro-trial', body, {
        headers: { 'x-admin-token': token },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: keys.billing });
      toast.success(`已为 ${res.email} 开通 ${res.plan} 试用（+${res.credits} 额度）`);
    },
    onError: (e: Error) => toast.error('发放失败', e.message),
  });
}

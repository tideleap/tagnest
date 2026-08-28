import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiProbeResult, AiSettings } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

export function useAiSettings() {
  return useQuery({
    queryKey: keys.aiSettings,
    queryFn: () => api.get<AiSettings>('/ai/settings'),
    staleTime: 5 * 60_000,
  });
}

export function useUpdateAiSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AiSettings> & { apiKey?: string }) =>
      api.put<AiSettings>('/ai/settings', patch),
    onSuccess: (next) => {
      qc.setQueryData(keys.aiSettings, next);
      toast.success('设置已保存');
    },
    onError: (e: Error) => toast.error('保存失败', e.message),
  });
}

/**
 * Probes a (possibly unsaved) AI endpoint. Omitted fields fall back to the
 * stored settings server-side, so this works both before and after saving.
 * The result is rendered by the caller — no toast here, the banner is the UI.
 */
export function useTestAiConnection() {
  return useMutation({
    mutationFn: (input: {
      provider?: string;
      baseUrl?: string | null;
      model?: string | null;
      apiKey?: string;
    }) => api.post<AiProbeResult>('/ai/test-connection', input),
  });
}

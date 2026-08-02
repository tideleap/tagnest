import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiSettings } from '@shared/types';
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

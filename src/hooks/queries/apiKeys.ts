import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiKey, ApiKeyCreated, ApiKeyInput } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

export function useApiKeys() {
  return useQuery({
    queryKey: keys.apiKeys,
    queryFn: () => api.get<{ items: ApiKey[] }>('/keys').then((r) => r.items),
    staleTime: 60_000,
  });
}

/**
 * Creates a key.
 *
 * The plaintext token comes back once and is handed to the caller rather than
 * cached — the settings page holds it in component state until the dialog is
 * dismissed, and nothing writes it to storage.
 */
export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApiKeyInput) => api.post<ApiKeyCreated>('/keys', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.apiKeys });
    },
    onError: (e: Error) => toast.error('创建失败', e.message),
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/keys/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.apiKeys });
      toast.success('密钥已删除');
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

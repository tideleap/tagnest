import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Share, ShareInput } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

export function useShares() {
  return useQuery({
    queryKey: keys.shares,
    queryFn: () => api.get<{ items: Share[] }>('/shares').then((r) => r.items),
    staleTime: 60_000,
  });
}

export function useCreateShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ShareInput) => api.post<Share>('/shares', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.shares });
      toast.success('分享页已创建');
    },
    onError: (e: Error) => toast.error('创建失败', e.message),
  });
}

export function useUpdateShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<ShareInput> }) =>
      api.patch<Share>(`/shares/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.shares });
    },
    onError: (e: Error) => toast.error('更新失败', e.message),
  });
}

export function useDeleteShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/shares/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.shares });
      toast.success('分享页已删除');
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

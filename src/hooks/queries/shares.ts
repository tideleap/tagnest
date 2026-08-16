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

/**
 * H2 / C3 — "收藏即收集". Copies a public share's bookmarks into the current
 * user's library. `urls` scopes the collect to specific items (per-item
 * "收藏"); omit it to collect the whole page. The password header is forwarded
 * so protected shares stay protected when collected from an unlocked session.
 */
export function useCollectShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      slug,
      urls,
      tagNames,
      password,
    }: {
      slug: string;
      urls?: string[];
      tagNames?: string[];
      password?: string;
    }) =>
      api.post<{ added: number; skipped: number; failed: number; total: number }>(
        `/shares/${slug}/collect`,
        { urls, tagNames },
        password ? { headers: { 'X-Share-Password': password } } : undefined,
      ),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      const parts = [`已收藏 ${res.added} 条`];
      if (res.skipped > 0) parts.push(`跳过 ${res.skipped} 条已存在`);
      if (res.failed > 0) parts.push(`${res.failed} 条失败`);
      toast.success(parts.join('，'));
    },
    onError: (e: Error) => toast.error('收藏失败', e.message),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrivateTagsResponse, Tag, TagInput } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

export function useTags() {
  return useQuery({
    queryKey: keys.tags,
    queryFn: () => api.get<Tag[]>('/tags'),
    staleTime: 60_000,
  });
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TagInput) => api.post<Tag>('/tags', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tags });
      toast.success('标签已创建');
    },
    onError: (e: Error) => toast.error('创建失败', e.message),
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<TagInput> }) =>
      api.patch<Tag>(`/tags/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
    },
    onError: (e: Error) => toast.error('更新失败', e.message),
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tags/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      toast.success('标签已删除');
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

export function useMergeTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sourceIds: string[]; targetId: string }) =>
      api.post<{ merged: number }>('/tags/merge', input),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      toast.success(`已合并 ${res.merged} 个标签`);
    },
    onError: (e: Error) => toast.error('合并失败', e.message),
  });
}

/**
 * Authorized listing of every private tag and the plaintext bookmarks it
 * currently hides. Surfaces what PRIVATE_BOOKMARK_CLAUSE hides so the owner
 * can review and un-private a category from the /private page.
 */
export function usePrivateTags(q?: string) {
  return useQuery({
    queryKey: [...keys.privateTags, q?.trim().toLowerCase() ?? ''],
    queryFn: () =>
      api.get<PrivateTagsResponse>(`/private/tags${q ? `?q=${encodeURIComponent(q.trim())}` : ''}`),
    staleTime: 30_000,
  });
}

/**
 * Toggles a tag's category-private flag. Setting it true cascades (server-side,
 * via the recursive CTE in setTagPrivate) to the whole subtree; clearing it
 * restores every descendant tag and re-surfaces all affected bookmarks.
 */
export function useSetTagPrivate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isPrivate }: { id: string; isPrivate: boolean }) =>
      api.patch<Tag>(`/tags/${id}`, { isPrivate } as Partial<TagInput>),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.privateTags });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      toast.success(vars.isPrivate ? '类别已设为私密' : '类别已取消私密');
    },
    onError: (e: Error) => toast.error('操作失败', e.message),
  });
}

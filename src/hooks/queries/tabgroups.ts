import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GroupWithItems, TabGroup, TabItem } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

export function useTabGroups() {
  return useQuery({
    queryKey: keys.tabGroups,
    queryFn: () =>
      api.get<{ items: TabGroup[]; total: number }>('/tab-groups').then((r) => r.items),
    staleTime: 30_000,
  });
}

export function useTabGroup(id: string | null) {
  return useQuery({
    queryKey: keys.tabGroup(id ?? ''),
    queryFn: () => api.get<GroupWithItems>(`/tab-groups/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateTabGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; colorIndex?: number }) =>
      api.post<TabGroup>('/tab-groups', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tabGroups });
      toast.success('分组已创建');
    },
    onError: (e: Error) => toast.error('创建失败', e.message),
  });
}

export function useUpdateTabGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; colorIndex?: number } }) =>
      api.patch<TabGroup>(`/tab-groups/${id}`, patch),
    onSuccess: (group) => {
      void qc.invalidateQueries({ queryKey: keys.tabGroups });
      void qc.invalidateQueries({ queryKey: keys.tabGroup(group.id) });
    },
    onError: (e: Error) => toast.error('更新失败', e.message),
  });
}

export function useDeleteTabGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tab-groups/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tabGroups });
      toast.success('分组已删除');
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

export function useAddTabItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, bookmarkId }: { groupId: string; bookmarkId: string }) =>
      api.post<TabItem>(`/tab-groups/${groupId}/items`, { bookmarkId }),
    onSuccess: (item) => {
      void qc.invalidateQueries({ queryKey: keys.tabGroup(item.groupId) });
      void qc.invalidateQueries({ queryKey: keys.tabGroups });
    },
    onError: (e: Error) => toast.error('添加失败', e.message),
  });
}

export function useRemoveTabItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, itemId }: { groupId: string; itemId: string }) =>
      api.delete(`/tab-groups/${groupId}/items/${itemId}`),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: keys.tabGroup(vars.groupId) });
      void qc.invalidateQueries({ queryKey: keys.tabGroups });
    },
    onError: (e: Error) => toast.error('移除失败', e.message),
  });
}

export function useReorderTabItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ids }: { groupId: string; ids: string[] }) =>
      api.patch<{ reordered: number }>(`/tab-groups/${groupId}/items`, { ids }),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: keys.tabGroup(vars.groupId) });
    },
    onError: (e: Error) => toast.error('排序保存失败', e.message),
  });
}

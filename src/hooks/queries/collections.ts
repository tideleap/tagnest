import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Collection, CollectionWithBookmarks, CollectionKind, SavedSearchQuery } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

/** List of all collections for the current user, oldest-first by name. */
export function useCollections() {
  return useQuery({
    queryKey: keys.collections,
    queryFn: () =>
      api.get<{ items: Collection[]; total: number }>('/collections').then((r) => r.items),
    staleTime: 30_000,
  });
}

/** A single collection with its member bookmarks (minimal shape). */
export function useCollection(id: string | null) {
  return useQuery({
    queryKey: keys.collection(id ?? ''),
    queryFn: () => api.get<CollectionWithBookmarks>(`/collections/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; colorIndex?: number; kind?: CollectionKind; query?: SavedSearchQuery }) =>
      api.post<Collection>('/collections', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.collections });
      toast.success('集合已创建');
    },
    onError: (e: Error) => toast.error('创建失败', e.message),
  });
}

export function useRenameCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { name?: string; colorIndex?: number; query?: SavedSearchQuery };
    }) => api.patch<Collection>(`/collections/${id}`, patch),
    onSuccess: (col) => {
      void qc.invalidateQueries({ queryKey: keys.collections });
      void qc.invalidateQueries({ queryKey: keys.collection(col.id) });
    },
    onError: (e: Error) => toast.error('更新失败', e.message),
  });
}

export function useDeleteCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/collections/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.collections });
      toast.success('集合已删除');
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

/** Adds an existing, non-trashed bookmark to a collection (idempotent). */
export function useAddToCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ collectionId, bookmarkId }: { collectionId: string; bookmarkId: string }) =>
      api.post<{ ok: true }>(`/collections/${collectionId}/bookmarks`, { bookmarkId }),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: keys.collection(vars.collectionId) });
      void qc.invalidateQueries({ queryKey: keys.collections });
    },
    onError: (e: Error) => toast.error('添加失败', e.message),
  });
}

/** Removes a bookmark from a collection. */
export function useRemoveFromCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ collectionId, bookmarkId }: { collectionId: string; bookmarkId: string }) =>
      api.delete(`/collections/${collectionId}/bookmarks?bookmarkId=${encodeURIComponent(bookmarkId)}`),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: keys.collection(vars.collectionId) });
      void qc.invalidateQueries({ queryKey: keys.collections });
    },
    onError: (e: Error) => toast.error('移除失败', e.message),
  });
}

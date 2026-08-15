import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Bookmark, BookmarkInput, BookmarkPatch, BookmarkQuery, Page } from '@shared/types';
import { api, qs } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys, PAGE_SIZE } from '@/hooks/queries/keys';

export function useBookmarks(query: BookmarkQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: keys.bookmarks(query),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<Bookmark>>(
        `/bookmarks${qs({
          scope: query.scope ?? 'all',
          q: query.q,
          tagIds: query.tagIds,
          matchAllTags: query.matchAllTags,
          sort: query.sort ?? 'created_desc',
          limit: query.limit ?? PAGE_SIZE,
          cursor: pageParam,
        })}`,
        { signal },
      ),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
    enabled,
  });
}

export function useBookmark(id: string | null) {
  return useQuery({
    queryKey: keys.bookmark(id ?? ''),
    queryFn: () => api.get<Bookmark>(`/bookmarks/${id}`),
    enabled: Boolean(id),
  });
}

/** Invalidate everything a bookmark write can affect. */
function useRefreshBookmarkViews() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
    void qc.invalidateQueries({ queryKey: keys.tags });
    void qc.invalidateQueries({ queryKey: keys.stats });
  };
}

export function useCreateBookmark() {
  const refresh = useRefreshBookmarkViews();
  return useMutation({
    mutationFn: (input: BookmarkInput) => api.post<Bookmark>('/bookmarks', input),
    onSuccess: (bm) => {
      refresh();
      toast.success('已保存', bm.title);
    },
    onError: (e: Error) => toast.error('保存失败', e.message),
  });
}

export function useUpdateBookmark() {
  const qc = useQueryClient();
  const refresh = useRefreshBookmarkViews();

  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: BookmarkPatch }) =>
      api.patch<Bookmark>(`/bookmarks/${id}`, patch),
    onSuccess: (bm) => {
      qc.setQueryData(keys.bookmark(bm.id), bm);
      refresh();
    },
    onError: (e: Error) => toast.error('更新失败', e.message),
  });
}

/**
 * Favourite toggling is optimistic: the star must respond instantly or the
 * interaction feels broken, and a rollback on failure is cheap.
 */
export function useToggleFavorite() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id, isFavorite }: { id: string; isFavorite: boolean }) =>
      api.patch<Bookmark>(`/bookmarks/${id}`, { isFavorite }),

    onMutate: async ({ id, isFavorite }) => {
      await qc.cancelQueries({ queryKey: keys.bookmarksRoot });
      const snapshot = qc.getQueriesData<{ pages: Page<Bookmark>[] }>({
        queryKey: keys.bookmarksRoot,
      });

      qc.setQueriesData<{ pages: Page<Bookmark>[]; pageParams: unknown[] }>(
        { queryKey: keys.bookmarksRoot },
        (old) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((b) => (b.id === id ? { ...b, isFavorite } : b)),
            })),
          };
        },
      );

      // Keep the single-bookmark view (BookmarkEditor) in step too; without
      // this, an open editor would show a stale isFavorite and could write the
      // old value back on save, silently undoing the toggle.
      qc.setQueryData<Bookmark>(keys.bookmark(id), (old) => (old ? { ...old, isFavorite } : old));

      return { snapshot };
    },

    onError: (e: Error, _vars, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
      toast.error('操作失败', e.message);
    },

    onSettled: (_a, _b, vars) => {
      void qc.invalidateQueries({ queryKey: keys.stats });
      void qc.invalidateQueries({ queryKey: keys.bookmark(vars.id) });
    },
  });
}

export function useTrashBookmarks() {
  const refresh = useRefreshBookmarkViews();
  const restore = useRestoreBookmarks();

  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ moved: number }>('/bookmarks/trash', { ids }),
    onSuccess: (res, ids) => {
      refresh();
      // Undo matters here: a mis-click on a multi-select is otherwise
      // unrecoverable without digging through the trash.
      toast.action(`已移入回收站 ${res.moved} 项`, {
        label: '撤销',
        onClick: () => restore.mutate(ids),
      });
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

export function useRestoreBookmarks() {
  const refresh = useRefreshBookmarkViews();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ restored: number }>('/bookmarks/restore', { ids }),
    onSuccess: () => {
      refresh();
      toast.success('已恢复');
    },
    onError: (e: Error) => toast.error('恢复失败', e.message),
  });
}

export function useDeleteForever() {
  const refresh = useRefreshBookmarkViews();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ deleted: number }>('/bookmarks/purge', { ids }),
    onSuccess: (res) => {
      refresh();
      toast.success(`已永久删除 ${res.deleted} 项`);
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

export function useBulkTag() {
  const refresh = useRefreshBookmarkViews();
  return useMutation({
    mutationFn: (input: { ids: string[]; addTagNames?: string[]; removeTagIds?: string[] }) =>
      api.post<{ updated: number }>('/bookmarks/bulk-tag', input),
    onSuccess: (res) => {
      refresh();
      toast.success(`已更新 ${res.updated} 项`);
    },
    onError: (e: Error) => toast.error('批量操作失败', e.message),
  });
}

/**
 * Persists a drag arrangement.
 *
 * Optimistic by necessity: the card is already under the user's cursor in its
 * new position, so waiting for the round trip would make it snap back and
 * forward again. The cached pages are rewritten to the new order, and the
 * snapshot restores them if the write fails.
 */
export function useReorderBookmarks() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ reordered: number }>('/bookmarks/reorder', { ids }),

    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: keys.bookmarksRoot });
      const snapshot = qc.getQueriesData<{ pages: Page<Bookmark>[] }>({
        queryKey: keys.bookmarksRoot,
      });

      const rank = new Map(ids.map((id, index) => [id, index]));

      qc.setQueriesData<{ pages: Page<Bookmark>[]; pageParams: unknown[] }>(
        { queryKey: keys.bookmarksRoot },
        (old) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              // Only rows named in the request move; anything else keeps its
              // relative position, which matters when a later page is loaded.
              items: [...page.items].sort((a, b) => {
                const ra = rank.get(a.id);
                const rb = rank.get(b.id);
                if (ra === undefined || rb === undefined) return 0;
                return ra - rb;
              }),
            })),
          };
        },
      );

      return { snapshot };
    },

    onError: (e: Error, _ids, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
      toast.error('排序保存失败', e.message);
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
    },
  });
}

/** Fire-and-forget visit counter; a failure here should never surface. */
export function useRecordVisit() {
  return useMutation({
    mutationFn: (id: string) => api.post(`/bookmarks/${id}/visit`),
    onError: () => undefined,
  });
}

export function useFetchMetadata() {
  return useMutation({
    mutationFn: (url: string) =>
      api.post<{ title: string; description: string | null; faviconUrl: string | null }>(
        '/metadata',
        { url },
      ),
  });
}

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AiSettings,
  Bookmark,
  BookmarkInput,
  BookmarkPatch,
  BookmarkQuery,
  ImportCommit,
  ImportPreview,
  ImportResult,
  Page,
  Stats,
  Tag,
  TagInput,
} from '@shared/types';
import { api, qs } from '@/lib/api';
import { toast } from '@/components/ui/Toast';

/**
 * Central key registry.
 *
 * Every cache key in the app is built here, which makes invalidation
 * auditable — the alternative is inline string arrays that silently diverge
 * and leave stale lists on screen after a mutation.
 */
export const keys = {
  bookmarks: (q: BookmarkQuery) => ['bookmarks', q] as const,
  bookmarksRoot: ['bookmarks'] as const,
  bookmark: (id: string) => ['bookmark', id] as const,
  tags: ['tags'] as const,
  stats: ['stats'] as const,
  aiSettings: ['ai-settings'] as const,
};

const PAGE_SIZE = 40;

/* ------------------------------------------------------------------ *
 * Bookmarks
 * ------------------------------------------------------------------ */

export function useBookmarks(query: BookmarkQuery) {
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

      return { snapshot };
    },

    onError: (e: Error, _vars, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
      toast.error('操作失败', e.message);
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.stats });
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

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Stats, import/export, AI settings
 * ------------------------------------------------------------------ */

export function useStats() {
  return useQuery({
    queryKey: keys.stats,
    queryFn: () => api.get<Stats>('/stats'),
    staleTime: 60_000,
  });
}

export function useImportPreview() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.post<ImportPreview>('/import/preview', form);
    },
    onError: (e: Error) => toast.error('解析失败', e.message),
  });
}

export function useImportCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportCommit) => api.post<ImportResult>('/import/commit', input),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.stats });
      toast.success(`导入完成：${res.imported} 项`, `跳过 ${res.skipped}，失败 ${res.failed}`);
    },
    onError: (e: Error) => toast.error('导入失败', e.message),
  });
}

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

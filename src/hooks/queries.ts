import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AiSettings,
  ApiKey,
  ApiKeyCreated,
  ApiKeyInput,
  Bookmark,
  BookmarkInput,
  BookmarkPatch,
  BookmarkQuery,
  ImportCommit,
  ImportPreview,
  ImportResult,
  Page,
  Share,
  ShareInput,
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
  apiKeys: ['api-keys'] as const,
  shares: ['shares'] as const,
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

/* ------------------------------------------------------------------ *
 * Personal access keys
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Public shares
 * ------------------------------------------------------------------ */

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

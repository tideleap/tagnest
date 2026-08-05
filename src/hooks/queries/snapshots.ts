import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

export interface BookmarkSnapshot {
  key: string;
  url: string;
  isLatest: boolean;
  capturedAt: string | null;
}

export interface SnapshotList {
  bookmarkId: string;
  snapshots: BookmarkSnapshot[];
  count: number;
}

/**
 * Generates a fresh website snapshot for a bookmark via POST
 * /bookmarks/:id/snapshot. The backend already does the heavy lifting
 * (capture → R2 store → retention prune); the frontend just had no entry
 * point until now. On success the bookmark views are invalidated so the
 * card's cover swaps to the new first-party image automatically.
 */
export function useGenerateSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ snapshotKey: string }>(`/bookmarks/${id}/snapshot`),
    onSuccess: (_res, id) => {
      void qc.invalidateQueries({ queryKey: ['bookmark-snapshots', id] });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.bookmark(id) });
      toast.success('快照已生成');
    },
    onError: (e: Error) => toast.error('生成快照失败', e.message),
  });
}

/**
 * Lists a bookmark's retained snapshot history (GET /bookmarks/:id/snapshots).
 * Disabled until an id is known so it never fires for a closed viewer.
 */
export function useBookmarkSnapshots(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['bookmark-snapshots', id ?? ''],
    queryFn: () => api.get<SnapshotList>(`/bookmarks/${id}/snapshots`),
    enabled: Boolean(id) && enabled,
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BookmarkSnapshotStatus } from '@shared/types';
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

/**
 * Time machine (O2): promotes a retained historical snapshot to be the
 * bookmark's current preview via POST /bookmarks/:id/snapshots/restore. The
 * backend does a lossless pointer swap on `snapshot_key`, so restoring is
 * idempotent and instantly reversible — no confirmation dialog needed.
 */
export function useRestoreSnapshot(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      api.post<{ snapshotKey: string }>(`/bookmarks/${id}/snapshots/restore`, { key }),
    onSuccess: (_res, key) => {
      void qc.invalidateQueries({ queryKey: ['bookmark-snapshots', id ?? ''] });
      void qc.invalidateQueries({ queryKey: bookmarkSnapshotStatusKey(id ?? '') });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      if (id) void qc.invalidateQueries({ queryKey: keys.bookmark(id) });
      toast.success('已恢复到该版本', `快照 ${key.split('-').pop()?.replace('.webp', '') ?? ''} 现为当前预览`);
    },
    onError: (e: Error) => toast.error('恢复失败', e.message),
  });
}

export const bookmarkSnapshotStatusKey = (id: string) => ['bookmark-snapshot-status', id] as const;

/**
 * Fetches the lightweight snapshot status for one bookmark ONCE when the card
 * scrolls into view. This used to poll every 30s per card — with N visible
 * cards that meant N requests every 30 seconds, indefinitely. The status only
 * feeds the stale dot, the lazy-capture decision and the live cover key, and
 * all of those are event-driven: capture mutations invalidate this key (and
 * the bookmark list), so the data refreshes exactly when something changes.
 * A finite staleTime still re-checks on remounts after 5 minutes.
 */
export function useBookmarkSnapshotStatus(id: string | null, enabled = true) {
  return useQuery({
    queryKey: bookmarkSnapshotStatusKey(id ?? ''),
    queryFn: () => api.get<BookmarkSnapshotStatus>(`/bookmarks/${id}/snapshot/status`),
    enabled: Boolean(id) && enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * Generates a fresh website snapshot for a single bookmark.
 * On success the card's snapshot status and bookmark list are invalidated.
 */
export function useRefreshBookmarkSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ snapshotKey: string }>(`/bookmarks/${id}/snapshot`),
    onSuccess: (_res, id) => {
      void qc.invalidateQueries({ queryKey: bookmarkSnapshotStatusKey(id) });
      void qc.invalidateQueries({ queryKey: ['bookmark-snapshots', id] });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.bookmark(id) });
      toast.success('快照已更新');
    },
    onError: (e: Error) => toast.error('刷新快照失败', e.message),
  });
}

/**
 * Silent variant of the capture mutation: same POST + invalidation, but no
 * toast. Used by the lazy snapshot scheduler (src/lib/snapshotScheduler.ts),
 * which may (re)capture many cards as they scroll into view — surfacing a
 * toast per capture would be noise. Failures are swallowed here because the
 * scheduler will simply retry the card on its next interval.
 */
export function useCaptureSnapshotSilent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ snapshotKey: string }>(`/bookmarks/${id}/snapshot`),
    onSuccess: (_res, id) => {
      void qc.invalidateQueries({ queryKey: bookmarkSnapshotStatusKey(id) });
      void qc.invalidateQueries({ queryKey: ['bookmark-snapshots', id] });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.bookmark(id) });
    },
  });
}

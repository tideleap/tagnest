import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BookmarkSnapshotStatus, SnapshotMonitorItem, SnapshotMonitorStatus } from '@shared/types';
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

export const SNAPSHOT_MONITOR_KEY = ['snapshot-monitor'] as const;

/**
 * Real-time snapshot monitor: top N bookmarks that already have a snapshot,
 * ordered by visits + recency. Refreshes automatically every 30s so the first
 * screen always shows the latest visual state.
 */
export function useSnapshotMonitor(enabled = true) {
  return useQuery({
    queryKey: SNAPSHOT_MONITOR_KEY,
    queryFn: () => api.get<SnapshotMonitorStatus>('/snapshots/monitor'),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export const bookmarkSnapshotStatusKey = (id: string) => ['bookmark-snapshot-status', id] as const;

/**
 * Polls the lightweight status for one bookmark's snapshot. Used inside each
 * card to show freshness and trigger automatic refreshes without pulling the
 * full monitor list.
 */
export function useBookmarkSnapshotStatus(id: string | null, enabled = true) {
  return useQuery({
    queryKey: bookmarkSnapshotStatusKey(id ?? ''),
    queryFn: () => api.get<BookmarkSnapshotStatus>(`/bookmarks/${id}/snapshot/status`),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    enabled: Boolean(id) && enabled,
  });
}

interface RefreshMonitorResponse {
  item: SnapshotMonitorItem;
  refreshedAt: string;
}

/**
 * Refreshes one bookmark in the monitor strip. Without a `bookmarkId` the
 * backend refreshes the bookmark whose snapshot is oldest (round-robin), which
 * is how the automatic rotation is implemented.
 */
export function useRefreshSnapshotMonitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { bookmarkId?: string } = {}) =>
      api.post<RefreshMonitorResponse>('/snapshots/monitor', opts.bookmarkId ? { bookmarkId: opts.bookmarkId } : {}),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: SNAPSHOT_MONITOR_KEY });
      void qc.invalidateQueries({ queryKey: bookmarkSnapshotStatusKey(res.item.bookmarkId) });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.bookmark(res.item.bookmarkId) });
      toast.success(`${res.item.title || '书签'} 快照已更新`);
    },
    onError: (e: Error) => toast.error('刷新快照失败', e.message),
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

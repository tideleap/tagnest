import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

export interface StorageUsage {
  totalBytes: number;
  snapshotBytes: number;
  snapshotCount: number;
  totalCount: number;
  otherCount: number;
  otherBytes: number;
  quotaBytes: number;
  quotaFmt: string;
  /** `snapshotBytes` rendered human-readable by the API. */
  snapshotFmt: string;
  display: string;
}

export interface ExportPreview {
  liveCount: number;
  trashCount: number;
  allCount: number;
  tagCount: number;
  snapshotCount: number;
  exportedAt: string | null;
}

export interface CleanupReport {
  scanned: number;
  rewritten: number;
  droppedKeys: number;
  dropped: string[];
}

/** R2 storage usage (global snapshot footprint). */
export function useStorageUsage() {
  return useQuery({
    queryKey: keys.storageUsage,
    queryFn: () => api.get<StorageUsage>('/storage/usage'),
    staleTime: 60_000,
  });
}

/** Counts shown in the export panel before starting an export. */
export function useExportPreview() {
  return useQuery({
    queryKey: keys.exportPreview,
    queryFn: () => api.get<ExportPreview>('/export/preview'),
    staleTime: 60_000,
  });
}

/** Runs the "clean orphan snapshot records" maintenance job. */
export function useCleanupSnapshots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CleanupReport>('/storage/cleanup'),
    onSuccess: (report) => {
      qc.invalidateQueries({ queryKey: keys.storageUsage });
      qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      if (report.droppedKeys > 0) {
        toast.success(`已清理 ${report.droppedKeys} 条孤立快照记录`);
      } else {
        toast.success('未发现孤立快照记录');
      }
    },
    onError: (e: Error) => toast.error('清理失败', e.message),
  });
}

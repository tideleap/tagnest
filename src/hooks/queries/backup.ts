import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BackupRun, BackupTarget, BackupTargetInput } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

export function useBackupTargets() {
  return useQuery({
    queryKey: keys.backupTargets,
    queryFn: () => api.get<BackupTarget[]>('/backup/targets'),
  });
}

export function useBackupRuns() {
  return useQuery({
    queryKey: keys.backupRuns,
    queryFn: () => api.get<BackupRun[]>('/backup/runs'),
  });
}

export function useUpsertBackupTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BackupTargetInput) => api.put<BackupTarget>('/backup/targets', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.backupTargets });
      toast.success('已保存备份目标');
    },
    onError: (e: Error) => toast.error('保存失败', e.message),
  });
}

export function useDeleteBackupTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/backup/targets/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.backupTargets });
      void qc.invalidateQueries({ queryKey: keys.backupRuns });
      toast.success('已删除备份目标');
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

export function useRunBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (targetId?: string) =>
      api.post<{ results: Array<{ targetId: string; status: string; error?: string }> }>(
        '/backup/run',
        targetId ? { targetId } : {},
      ),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.backupTargets });
      void qc.invalidateQueries({ queryKey: keys.backupRuns });
      const failed = res.results.filter((r) => r.status !== 'ok');
      if (failed.length === 0) toast.success('备份已完成');
      else toast.error('部分备份失败', failed.map((r) => r.error ?? '未知错误').join('；'));
    },
    onError: (e: Error) => toast.error('备份失败', e.message),
  });
}

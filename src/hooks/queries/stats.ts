import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportCommit, ImportPreview, ImportResult, Stats } from '@shared/types';
import { api, requestNdjson, type ImportProgress } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';
import { useState } from 'react';

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
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const mutation = useMutation({
    mutationFn: (input: ImportCommit) =>
      requestNdjson<ImportResult>('/import/commit', input, setProgress, { timeoutMs: 120_000 }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.stats });
      toast.success(`导入完成：${res.imported} 项`, `跳过 ${res.skipped}，失败 ${res.failed}`);
      setProgress(null);
    },
    onError: (e: Error) => {
      toast.error('导入失败', e.message);
      setProgress(null);
    },
    onMutate: () => setProgress({ done: 0, total: 0, skipped: 0, failed: 0 }),
  });
  return { ...mutation, progress };
}

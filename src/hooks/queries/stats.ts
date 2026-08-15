import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportCommit, ImportPreview, ImportResult, Stats, StatsTrend } from '@shared/types';
import { api, requestNdjson, type ImportProgress } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';
import { describeImportError } from '@/lib/import-error';
import { useState } from 'react';

export function useStats() {
  return useQuery({
    queryKey: keys.stats,
    queryFn: () => api.get<Stats>('/stats'),
    staleTime: 60_000,
  });
}

/** A3 — per-day additions for the report page's trend chart. */
export function useStatsTrend(days = 180) {
  return useQuery({
    queryKey: [...keys.statsTrend, days] as const,
    queryFn: () => api.get<StatsTrend>(`/stats/trend?days=${days}`),
    staleTime: 5 * 60_000,
  });
}

export function useImportPreview() {
  return useMutation({
    mutationFn: async (file: File) => {
      // Send the file as base64 inside a JSON body instead of multipart/form-data.
      // Cloudflare Pages Functions rejects multipart uploads larger than ~16 KB at
      // the *edge* (HTTP 503 before the function runs), so any real bookmark file
      // fails. A JSON body streams through normally and keeps the raw bytes (so
      // GBK / UTF-16 exports decode correctly server-side).
      const buf = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
      }
      const content = btoa(binary);
      return api.post<ImportPreview>('/import/preview', {
        fileName: file.name,
        content,
        encoding: 'base64',
      });
    },
    onError: (e: Error) => {
      const info = describeImportError(e);
      toast.error(info.title, info.hint + (info.detail ? `\n${info.detail}` : ''));
    },
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
      // Reuse the same classifier so commit failures get the same clear
      // title/hint split as preview (e.g. a 503 database blip becomes "请稍后
      // 重试" instead of a raw server error message).
      const info = describeImportError(e);
      toast.error(info.title, info.hint + (info.detail ? `\n${info.detail}` : ''));
      setProgress(null);
    },
    onMutate: () => setProgress({ done: 0, total: 0, skipped: 0, failed: 0 }),
  });
  return { ...mutation, progress };
}

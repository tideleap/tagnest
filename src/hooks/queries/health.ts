import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HealthReport, ProbeResult } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

/**
 * O1 — library health data layer.
 *
 * The structural report (duplicates + orphan tags + score) is instant and
 * cacheable; liveness probing is a mutation because it performs outbound
 * fetches and returns results inline.
 */

export function useHealthReport(enabled = true) {
  return useQuery({
    queryKey: keys.health,
    queryFn: () => api.get<HealthReport>('/bookmarks/health'),
    staleTime: 60_000,
    enabled,
  });
}

export function useProbeBookmarks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ results: ProbeResult[] }>('/bookmarks/health/probe', { ids }),
    onSuccess: (data) => {
      const dead = data.results.filter((r) => r.status === 'dead').length;
      if (dead > 0) toast.info('检查完成', `发现 ${dead} 个失效链接`);
      else toast.success('检查完成', '这批书签都能正常访问');
    },
    onError: (e: Error) => toast.error('检查失败', e.message),
    onSettled: () => {
      // Probing never mutates, but the report counters may have drifted.
      void qc.invalidateQueries({ queryKey: keys.health });
    },
  });
}

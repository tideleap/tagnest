import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AiJob } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

/**
 * Data layer for the AI batch-run history.
 *
 * Running a job already lives on the Organize page (`useOrganizeRun`). What was
 * missing is any way to *see* past runs, watch a long one that is still going,
 * or stop one that has outlived its usefulness — the three read/delete
 * endpoints on `/api/ai/jobs` had no caller. This module is that caller.
 */

/** Most recent runs for the current user. */
export function useAiJobs() {
  return useQuery({
    queryKey: keys.aiJobs,
    queryFn: () => api.get<{ jobs: AiJob[] }>('/ai/jobs'),
    staleTime: 15_000,
  });
}

/** One run's progress; used by the expandable detail row. */
export function useAiJob(id: string | null) {
  return useQuery({
    queryKey: keys.aiJob(id ?? ''),
    queryFn: () => api.get<{ job: AiJob }>(`/ai/jobs/${id}`),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

/**
 * Cancels a run.
 *
 * The backend only *cancels* (it never hard-deletes a row): a queued or running
 * job flips to `cancelled`, a finished one is returned untouched. So the button
 * is offered only while the job is still active — a terminal run has nothing to
 * cancel, and showing a no-op "delete" would be a lie.
 */
export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ job: AiJob }>(`/ai/jobs/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.aiJobs });
      void qc.invalidateQueries({ queryKey: keys.aiOverview });
      toast.success('已取消整理任务');
    },
    onError: (e: Error) => toast.error('操作失败', e.message),
  });
}

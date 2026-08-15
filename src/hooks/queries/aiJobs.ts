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

/**
 * Undoes one settled run's accepted work (plan T2 "可撤销").
 *
 * Removes the AI-written tag links and puts the accepted suggestions back in
 * the review queue. Everything the run touched is cache-invalidated, because
 * undo changes the library itself (tag links), the queue (restored proposals)
 * and the counters (AI contribution).
 */
export function useUndoJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{
        job: AiJob;
        removedLinks: number;
        restoredSuggestions: number;
        droppedSuggestions: number;
      }>(`/ai/jobs/${id}/undo`),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: keys.aiJobs });
      void qc.invalidateQueries({ queryKey: keys.aiOverview });
      void qc.invalidateQueries({ queryKey: keys.aiSuggestionsRoot });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.stats });
      void qc.invalidateQueries({ queryKey: keys.aiTaxonomy });
      toast.success(
        `已撤销：移除 ${result.removedLinks} 个 AI 标签，${result.restoredSuggestions} 条建议回到待确认`,
      );
    },
    onError: (e: Error) => toast.error('撤销失败', e.message),
  });
}

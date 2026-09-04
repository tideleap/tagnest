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
 *
 * B-7: the toast follows the *actual* result status instead of assuming success.
 * A `finalizing` job cannot be cancelled (its partitions already finished), and
 * a settled job is returned untouched — both used to toast 「已取消」, which was
 * a lie. Now each outcome gets its own message, and `finalizing` points the user
 * at the 完成收尾 recovery button.
 */
export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ cancelled: boolean; job: AiJob }>(`/ai/jobs/${id}`),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: keys.aiJobs });
      void qc.invalidateQueries({ queryKey: keys.aiOverview });
      if (result.cancelled) {
        toast.success('已取消整理任务');
      } else if (result.job.status === 'finalizing') {
        toast.info('该任务已完成推理、正在收尾，无法取消', '请点击「完成收尾」应用结果');
      } else {
        toast.info('任务已结束，无需取消');
      }
    },
    onError: (e: Error) => toast.error('操作失败', e.message),
  });
}

/**
 * B-7: recovers a job stuck in `finalizing`.
 *
 * After every partition finishes, the job is marked `finalizing` and the client
 * is expected to call `/finalize`. If the client closed or crashed before that
 * call, the job stays `finalizing` forever with its proposals already saved but
 * never applied. This mutation is the recovery entry point: the endpoint is
 * idempotent (a `done` job short-circuits, `finalizing` runs the wrap-up once),
 * so it is safe to fire automatically as well as from a button.
 */
export function useFinalizeJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ job: AiJob; autoApplied: number }>(`/ai/jobs/${id}/finalize`),
    onSuccess: () => {
      // Finalize applies auto-apply + hierarchy rebuild, so everything the
      // undo path invalidates is in scope here too.
      void qc.invalidateQueries({ queryKey: keys.aiJobs });
      void qc.invalidateQueries({ queryKey: keys.aiOverview });
      void qc.invalidateQueries({ queryKey: keys.aiSuggestionsRoot });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.stats });
      void qc.invalidateQueries({ queryKey: keys.aiTaxonomy });
      void qc.invalidateQueries({ queryKey: keys.categoryTree });
      void qc.invalidateQueries({ queryKey: keys.categoryWriteback });
      toast.success('收尾完成，整理结果已应用');
    },
    onError: (e: Error) => toast.error('收尾失败', e.message),
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

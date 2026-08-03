import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiEngineKind,
  AiJob,
  AiJobRunResult,
  AiJobTarget,
  AiOverview,
  AiSuggestion,
  AiTaxonomyAudit,
  Tag,
} from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

/**
 * Data layer for the AI organiser.
 *
 * The only non-obvious piece is `useOrganizeRun`: a batch run is a *client-
 * driven loop*, not a single request. See the comment on that hook.
 */

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function useAiOverview() {
  return useQuery({
    queryKey: keys.aiOverview,
    queryFn: () => api.get<AiOverview>('/ai/overview'),
    staleTime: 30_000,
  });
}

export function useAiSuggestions(jobId?: string | null) {
  return useQuery({
    queryKey: keys.aiSuggestions(jobId),
    queryFn: () =>
      api.get<{ suggestions: AiSuggestion[]; total: number }>(
        jobId ? `/ai/suggestions?jobId=${encodeURIComponent(jobId)}` : '/ai/suggestions',
      ),
    staleTime: 10_000,
  });
}

export function useAiTaxonomyAudit(enabled = true) {
  return useQuery({
    queryKey: keys.aiTaxonomy,
    queryFn: () => api.get<AiTaxonomyAudit>('/ai/taxonomy'),
    enabled,
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ *
 * Decisions
 * ------------------------------------------------------------------ */

export interface DecideInput {
  action: 'accept' | 'reject';
  ids?: string[];
  jobId?: string;
  bookmarkId?: string;
}

/**
 * Accepts or rejects proposals.
 *
 * Invalidates the bookmark and tag caches as well as the queue: accepting
 * writes real tag links, so a stale library list would show the bookmark
 * without the tag the user just approved.
 */
export function useDecideSuggestions() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: DecideInput) =>
      api.post<{ accepted: number; rejected: number; tagsCreated: number; pending: number }>(
        '/ai/suggestions/apply',
        input,
      ),
    onSuccess: (result, input) => {
      void qc.invalidateQueries({ queryKey: keys.aiSuggestionsRoot });
      void qc.invalidateQueries({ queryKey: keys.aiOverview });

      if (input.action === 'accept') {
        void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
        void qc.invalidateQueries({ queryKey: keys.tags });
        void qc.invalidateQueries({ queryKey: keys.stats });
        void qc.invalidateQueries({ queryKey: keys.aiTaxonomy });

        const created = result.tagsCreated > 0 ? `，新建 ${result.tagsCreated} 个标签` : '';
        toast.success(`已应用 ${result.accepted} 个标签${created}`);
      } else {
        toast.success(`已忽略 ${result.rejected} 条建议`);
      }
    },
    onError: (e: Error) => toast.error('操作失败', e.message),
  });
}

/** Re-analyses a small set of bookmarks immediately, bypassing the job flow. */
export function useSuggestNow() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (bookmarkIds: string[]) =>
      api.post<{
        suggestions: AiSuggestion[];
        engine: AiEngineKind;
        modelError: string | null;
        analyzed: number;
      }>('/ai/suggest', { bookmarkIds }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: keys.aiSuggestionsRoot });
      void qc.invalidateQueries({ queryKey: keys.aiOverview });

      if (result.suggestions.length === 0) {
        toast.info('没有产生新的标签建议');
      } else {
        toast.success(`生成 ${result.suggestions.length} 条标签建议`);
      }
      // A silent downgrade to local rules would look like a working model
      // producing worse output. Say so.
      if (result.modelError) toast.info('模型未参与本次分析', result.modelError);
    },
    onError: (e: Error) => toast.error('分析失败', e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Batch run
 * ------------------------------------------------------------------ */

export interface RunState {
  job: AiJob | null;
  running: boolean;
  engine: AiEngineKind | null;
  modelError: string | null;
  autoApplied: number;
  error: string | null;
}

const IDLE: RunState = {
  job: null,
  running: false,
  engine: null,
  modelError: null,
  autoApplied: 0,
  error: null,
};

/**
 * Drives a batch run to completion, chunk by chunk.
 *
 * ## Why a loop in the client
 *
 * Tagging a few thousand bookmarks takes minutes of model calls, which no
 * single request on Pages will survive. The server exposes the run as
 * `create job` + `run next chunk`, and this hook calls the second endpoint
 * repeatedly until it reports `done`.
 *
 * The cost is one round trip per 20 bookmarks. What it buys:
 *
 *  - **Real progress.** Every chunk returns fresh counters, so the bar moves
 *    for actual work completed rather than being an animation.
 *  - **Interruptibility.** `stop()` just breaks the loop. Proposals already
 *    written stay in the queue — nothing is wasted.
 *  - **Resumability.** Progress lives in the database. Reloading mid-run and
 *    pressing continue picks up at the same bookmark.
 *
 * `cancelledRef` is a ref rather than state because the loop reads it between
 * awaits, where a state value would be the one captured at render time.
 */
export function useOrganizeRun() {
  const qc = useQueryClient();
  const [state, setState] = useState<RunState>(IDLE);
  const cancelled = useRef(false);

  const stop = useCallback(() => {
    cancelled.current = true;
    setState((s) => ({ ...s, running: false }));
  }, []);

  const reset = useCallback(() => {
    cancelled.current = false;
    setState(IDLE);
  }, []);

  // If the user leaves the page mid-run, stop the long-poll loop — otherwise it
  // keeps firing /ai/jobs/:id/run in the background, invalidating caches and
  // setState-ing an unmounted component, burning API quota for nothing.
  useEffect(() => {
    return () => {
      cancelled.current = true;
    };
  }, [cancelled]);

  const start = useCallback(
    async (target: AiJobTarget, bookmarkIds?: string[]) => {
      cancelled.current = false;
      setState({ ...IDLE, running: true });

      let job: AiJob;
      try {
        const created = await api.post<{ job: AiJob }>('/ai/jobs', { target, bookmarkIds });
        job = created.job;
      } catch (e) {
        const message = e instanceof Error ? e.message : '无法创建整理任务';
        setState({ ...IDLE, error: message });
        return null;
      }

      setState((s) => ({ ...s, job, running: true }));

      let autoApplied = 0;

      // Bounded so a server bug that never advances `processed` cannot spin
      // forever; +2 covers the settle call after the last chunk.
      const maxIterations = Math.ceil(job.total / 20) + 2;

      for (let i = 0; i < maxIterations; i += 1) {
        if (cancelled.current) break;

        let result: AiJobRunResult;
        try {
          // Each chunk may call the model (up to 25s) plus D1 writes. The
          // default 15s client deadline is far too short and aborts the
          // request before the server can respond, leaving the user with a
          // false "timeout" while the chunk actually completed.
          result = await api.post<AiJobRunResult>(`/ai/jobs/${job.id}/run`, undefined, {
            timeoutMs: 90_000,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : '整理过程中断';
          setState((s) => ({ ...s, running: false, error: message }));
          return job;
        }

        autoApplied += result.autoApplied;
        setState({
          job: result.job,
          running: !result.done,
          engine: result.engine,
          modelError: result.modelError,
          autoApplied,
          error: result.job.status === 'failed' ? result.job.error : null,
        });

        // The queue grows as chunks land, so the review list stays live
        // instead of only appearing once everything has finished.
        void qc.invalidateQueries({ queryKey: keys.aiSuggestionsRoot });

        if (result.done) break;
      }

      void qc.invalidateQueries({ queryKey: keys.aiOverview });
      if (autoApplied > 0) {
        void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
        void qc.invalidateQueries({ queryKey: keys.tags });
      }

      setState((s) => ({ ...s, running: false }));
      return job;
    },
    [qc],
  );

  return { ...state, start, stop, reset };
}

/** Result of an auto-group run. */
export interface AutoGroupResult {
  createdCategories: number;
  relocated: number;
  untouched: number;
  summary: string[];
  tags: Tag[];
}

/**
 * Applies the automatic 一级→二级→三级 grouping to the user's tags and returns
 * the new tree. Invalidates the tag list + taxonomy audit on success.
 */
export function useAutoGroupTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AutoGroupResult>('/ai/taxonomy/group', {}),
    onSuccess: (result) => {
      void qc.setQueryData(keys.tags, result.tags);
      void qc.invalidateQueries({ queryKey: keys.tags });
      void qc.invalidateQueries({ queryKey: keys.aiTaxonomy });
      toast.success(
        `已建组：新建 ${result.createdCategories} 个分类，调整 ${result.relocated} 个标签`,
      );
    },
    onError: (e: Error) => toast.error('自动建组失败', e.message),
  });
}

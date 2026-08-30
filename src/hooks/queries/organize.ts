import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiAliasSuggestionsResponse,
  AiEngineKind,
  AiJob,
  AiJobEstimate,
  AiJobRunResult,
  AiJobTarget,
  AiOverview,
  AiSuggestion,
  AiTaxonomyAudit,
  AiTopicCount,
  AutoGroupResult,
} from '@shared/types';
import { api, qs } from '@/lib/api';
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

/**
 * A1 — pre-run cost forecast.
 *
 * The endpoint is pure computation (scope size + one measured sample prompt,
 * no model call), so it is cheap to refetch whenever the scope changes. The
 * query is disabled while a run is in flight: the forecast only makes sense
 * before pressing start.
 *
 * CategorySync: `kind` selects the organiser track. 'categorize' applies the
 * primary-category scope rules (bookmarks with a browser_folder placement are
 * skipped; `untagged` means "no primary category yet"), so the forecast must
 * be keyed by kind or the two tracks would share one stale number.
 */
export function useAiEstimate(
  target: AiJobTarget,
  enabled = true,
  kind: 'tagging' | 'categorize' | 'rename' = 'tagging',
) {
  return useQuery({
    queryKey: keys.aiEstimate(target, undefined, kind),
    queryFn: () =>
      api.get<{ estimate: AiJobEstimate }>(`/ai/jobs/estimate${qs({ target, kind })}`),
    enabled,
    staleTime: 30_000,
  });
}

export function useAiSuggestions(jobId?: string | null, kind?: 'tag' | 'category' | 'rename') {
  return useQuery({
    queryKey: keys.aiSuggestions(jobId, kind),
    queryFn: () =>
      api.get<{ suggestions: AiSuggestion[]; total: number }>(
        `/ai/suggestions${qs({ jobId: jobId ?? undefined, kind })}`,
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

export function useAiAliasSuggestions() {
  return useQuery({
    queryKey: keys.aiAliases,
    queryFn: () => api.get<AiAliasSuggestionsResponse>('/ai/taxonomy/aliases'),
    staleTime: 60_000,
  });
}

/**
 * Applies the user-confirmed aliases to `tags.aliases`.
 *
 * Optimistic cache update so the proposal list reflects the accept immediately;
 * on error the list is invalidated and refetched. Applying is additive only —
 * it never deletes a tag — so rolling back is just dropping the local edit.
 */
export function useApplyAliases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: Array<{ tagId: string; aliases: string[] }>) =>
      api.post<{ updated: number }>('/ai/taxonomy/aliases', { action: 'apply', apply: items }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.aiAliases });
      qc.invalidateQueries({ queryKey: keys.tags });
      toast.success('已写入别名，后续归一化会自动合并');
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: keys.aiAliases });
      toast.error('应用别名失败，请重试');
    },
  });
}

/**
 * Asks the model to propose richer aliases. Falls back to offline proposals
 * when no model is configured (the response carries `modelAvailable: false`).
 */
export function useGenerateAliases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagIds?: string[]) =>
      api.post<AiAliasSuggestionsResponse>('/ai/taxonomy/aliases', {
        action: 'generate',
        tagIds,
      }),
    onSuccess: (data) => {
      qc.setQueryData(keys.aiAliases, (prev: AiAliasSuggestionsResponse | undefined) => ({
        ...(prev ?? { aliasSuggestions: [], topicClusters: [] }),
        aliasSuggestions: data.aliasSuggestions,
        modelAvailable: data.modelAvailable,
      }));
    },
    onError: () => toast.error('AI 生成别名失败，请重试'),
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
  /** New spelling when a single suggestion is edited before accept. */
  renameTo?: string;
  /**
   * CategorySync (migration 0024): which queue the decision lands in.
   * 'tag' (default) writes `bookmark_tags`; 'category' writes the single
   * primary placement (`bookmark_primary_category`); 'rename' rewrites the
   * bookmark title itself. The server scopes the whole apply to one kind, so
   * a mixed batch is impossible by construction.
   */
  kind?: 'tag' | 'category' | 'rename';
}

/**
 * Accepts or rejects proposals.
 *
 * Invalidates the bookmark and tag caches as well as the queue: accepting
 * writes real tag links, so a stale library list would show the bookmark
 * without the tag the user just approved. For `kind='category'` decisions the
 * category tree and writeback mapping change too, so those caches refresh as
 * well. For `kind='rename'` decisions the bookmark *title* changes — which the
 * library list, search index and sync layer all render — but tags and the
 * category tree are untouched.
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

      const isCategory = input.kind === 'category';
      const isRename = input.kind === 'rename';

      if (input.action === 'accept') {
        void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
        void qc.invalidateQueries({ queryKey: keys.stats });
        if (isRename) {
          // A rename touches no tag data — only the title column — so the tag
          // list / taxonomy / category caches are deliberately left alone.
        } else {
          void qc.invalidateQueries({ queryKey: keys.tags });
          if (isCategory) {
            // Accepting a category proposal moves the bookmark's primary
            // placement — the tree counts and the writeback feed both change.
            void qc.invalidateQueries({ queryKey: keys.categoryTree });
            void qc.invalidateQueries({ queryKey: keys.categoryWriteback });
          } else {
            void qc.invalidateQueries({ queryKey: keys.aiTaxonomy });
          }
        }

        const created = result.tagsCreated > 0 ? `，新建 ${result.tagsCreated} 个标签` : '';
        toast.success(
          isCategory
            ? `已应用 ${result.accepted} 条分类`
            : isRename
              ? `已应用 ${result.accepted} 条命名`
              : `已应用 ${result.accepted} 个标签${created}`,
        );
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
  /** Bookmarks that received only the domain fallback across the run. */
  uncovered: number;
  /**
   * CategorySync (C1-7): bookmarks whose final placement is the catch-all
   * 「未分类」 across a categorize run (no model output AND no parseable
   * host signal). Always 0 for tagging runs.
   */
  uncategorized: number;
  error: string | null;
  /** Topic distribution accumulated across chunks, for the result chart. */
  topics: AiTopicCount[];
  /**
   * Automatic 一级→二级→③ grouping result from the final chunk.
   * Present once the run has settled successfully.
   */
  autoGrouped: AutoGroupResult | null;
  /**
   * P2-2: the run introduced a large share of new tags relative to the existing
   * taxonomy — a hint that a full re-classify would produce a cleaner tree.
   */
  rebalanceWarning: boolean;
}

const IDLE: RunState = {
  job: null,
  running: false,
  engine: null,
  modelError: null,
  autoApplied: 0,
  uncovered: 0,
  uncategorized: 0,
  error: null,
  topics: [],
  autoGrouped: null,
  rebalanceWarning: false,
};

/**
 * Merges per-chunk topic counts into a running total. Topics are de-duplicated
 * by name and summed, so the same topic appearing across chunks accumulates.
 */
function mergeTopicCounts(
  prev: AiTopicCount[],
  next: AiTopicCount[] | undefined,
): AiTopicCount[] {
  if (!next || next.length === 0) return prev;
  const totals = new Map<string, number>(prev.map((t) => [t.topic, t.count]));
  for (const { topic, count } of next) {
    totals.set(topic, (totals.get(topic) ?? 0) + count);
  }
  return [...totals.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

/**
 * Drives a batch run to completion via parallel partitions (方案A).
 *
 * ## Why parallel partitions
 *
 * Tagging/categorising thousands of bookmarks takes many model calls, which no
 * single Pages request will survive (30s wall-clock hard limit). The old design
 * looped one `run next chunk` call at a time — serial, and each chunk fetched
 * every page body, so a 168-bookmark run blew the timeout on the very first
 * chunk and never advanced past 0/total.
 *
 * The new design splits the scope into fixed 10-bookmark partitions and fires
 * up to 6 of them concurrently. Each partition carries `{ from, to }`, the
 * server advances an atomic counter, and the LAST partition to finish runs the
 * shared-state finalize (auto-apply / hierarchy rebuild) once. Because
 * categorization no longer fetches page bodies, a partition is a single fast
 * model call, so the whole run finishes in roughly one model-call's worth of
 * wall time.
 *
 *  - **Real progress.** Every partition returns fresh counters (read back from
 *    the atomic increment), so the bar moves for actual work completed.
 *  - **Interruptibility.** `stop()` flips `cancelled` / aborts the controller;
 *    in-flight partitions are cancelled and proposals already written stay.
 *  - **Concurrency safety.** Partitions own disjoint bookmark IDs, so their
 *    suggestion writes never collide; the counter increment is atomic, and the
 *    finalize runs exactly once, on the finisher.
 *
 * `cancelled` is a ref rather than state because the workers read it between
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
    async (
      target: AiJobTarget,
      bookmarkIds?: string[],
      limit?: number,
      kind: 'tagging' | 'categorize' | 'rename' = 'tagging',
      includeBrowserFolder?: boolean,
    ) => {
      cancelled.current = false;
      setState({ ...IDLE, running: true });

      let job: AiJob;
      try {
        const created = await api.post<{ job: AiJob }>('/ai/jobs', {
          target,
          bookmarkIds,
          limit,
          kind,
          // Only meaningful for categorize runs; the server ignores it otherwise.
          includeBrowserFolder,
        });
        job = created.job;
      } catch (e) {
        const message = e instanceof Error ? e.message : '无法创建整理任务';
        setState({ ...IDLE, error: message });
        return null;
      }

      setState((s) => ({ ...s, job, running: true }));

      let autoApplied = 0;
      let uncovered = 0;
      let uncategorized = 0;
      let lastJob: AiJob = job;
      let error: string | null = null;

      // 方案A: 把整理范围切成多个不重叠的分片，用固定并发的 worker 池并行打出
      // 去。每个分片带 {from,to} 认领一段书签，服务端用原子计数推进进度，所以
      // 进度条是实时的、且总时长从「N 个串行 round-trip」降到「约一次模型调用」。
      // 关掉抓取后单分片只剩一次模型调用，稳进 Cloudflare 的 30s 墙钟。
      const PARTITION = 10;
      const CONCURRENCY = 6;
      const partitions: Array<{ from: number; to: number }> = [];
      for (let from = 0; from < job.total; from += PARTITION) {
        partitions.push({ from, to: Math.min(from + PARTITION, job.total) });
      }

      // 取消 / 致命错误时让所有在途分片一并中止。
      const abort = new AbortController();

      const runPartition = async (part: { from: number; to: number }, attempt: number): Promise<void> => {
        if (cancelled.current || abort.signal.aborted) return;

        let result: AiJobRunResult;
        try {
          // 单分片只做一次模型调用（已关抓取），通常数秒；28s 客户端超时留足余量
          // 且仍低于 Pages Functions 的 30s 墙钟。
          result = await api.post<AiJobRunResult>(
            `/ai/jobs/${job.id}/run`,
            { from: part.from, to: part.to },
            { timeoutMs: 28_000, signal: abort.signal },
          );
        } catch (e) {
          if (cancelled.current || abort.signal.aborted) return;
          // 单次超时做一次瞬时重试，仍失败则中止整个 run。
          if ((e as { code?: string })?.code === 'timeout' && attempt < 1) {
            return runPartition(part, attempt + 1);
          }
          error = e instanceof Error ? e.message : '整理过程中断';
          abort.abort();
          return;
        }

        autoApplied += result.autoApplied;
        uncovered += result.uncovered;
        uncategorized += result.uncategorized ?? 0;
        lastJob = result.job;

        // 致命（fatal）模型错误：服务端已把任务置 failed，整体中止。
        if (result.job.status === 'failed' && result.modelError) {
          error = result.job.error ?? result.modelError;
          abort.abort();
        }

        setState((s) => ({
          job: result.job,
          running: true,
          engine: result.engine,
          modelError: result.modelError,
          autoApplied,
          uncovered,
          uncategorized,
          error: result.job.status === 'failed' ? result.job.error : null,
          topics: mergeTopicCounts(s.topics, result.topics),
          autoGrouped: result.autoGrouped ?? s.autoGrouped,
          rebalanceWarning: s.rebalanceWarning || result.rebalanceWarning,
        }));
      };

      const worker = async (): Promise<void> => {
        for (;;) {
          if (cancelled.current || abort.signal.aborted) return;
          const part = partitions.shift();
          if (!part) return;
          await runPartition(part, 0);
        }
      };

      const workers: Promise<void>[] = [];
      const workerCount = Math.max(1, Math.min(CONCURRENCY, partitions.length));
      for (let i = 0; i < workerCount; i += 1) workers.push(worker());
      await Promise.all(workers);

      // 用户中途取消或发生错误：取消不算错误；否则带上 error。
      setState((s) => ({
        ...s,
        job: lastJob,
        running: false,
        error: cancelled.current ? null : error,
      }));

      // Refresh once at the end rather than on every chunk: re-fetching the
      // full suggestions list per chunk wastes server load and API quota during
      // a long run, and the review queue only needs to be current after it
      // settles. The progress bar already reflects live chunk counts.
      void qc.invalidateQueries({ queryKey: keys.aiOverview });
      void qc.invalidateQueries({ queryKey: keys.aiSuggestionsRoot });
      // The forecast is stale once a run has consumed part of the scope
      // (untagged shrinks as suggestions are accepted).
      void qc.invalidateQueries({ queryKey: keys.aiEstimateRoot });
      if (kind === 'categorize') {
        // Placements may have landed (auto-apply or fallback writes), so the
        // tree counts and the writeback feed must refresh regardless of how
        // many rows the review queue still holds.
        void qc.invalidateQueries({ queryKey: keys.categoryTree });
        void qc.invalidateQueries({ queryKey: keys.categoryWriteback });
      }
      // Rename writes only titles; a title-bearing surface is covered by
      // bookmarksRoot below. Tags/category caches are untouched by design.
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

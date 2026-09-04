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
      api.post<{
        accepted: number;
        rejected: number;
        tagsCreated: number;
        pending: number;
        // B-20（第二轮审计）: 整批应用命中单次上限（500）时服务端回传截断标志，
        // 前端提示用户分次确认，而不是静默只处理前 500 条。
        truncated?: boolean;
        totalMatched?: number;
      }>('/ai/suggestions/apply', input),
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

      // B-20: 截断提示 —— 单次最多处理 500 条，队列里还有剩余，引导分次确认。
      if (result.truncated) {
        const remaining = Math.max(0, (result.totalMatched ?? 0) - (result.accepted + result.rejected));
        toast.info(`单次最多处理 500 条，队列中还有约 ${remaining} 条，请再次应用以继续`);
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
  /**
   * Bookmarks quarantined as suspected adult content across the run: never
   * sent to the model, deterministically labelled 「成人内容」 and flagged for
   * review. Surfaced so the user knows why some bookmarks skipped the model.
   */
  adultQuarantined: number;
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
  /** 方案A: 模型推理分片全部完成、正在调用 /finalize 收尾（auto-apply + 建组）时的瞬时状态。 */
  applying: boolean;
  /**
   * B-19（第二轮审计）: 当前是第几趟（0 = 主跑，≥1 = 补跑）。补跑会新建任务，
   * 计数器归零；UI 凭此展示「第 N 趟」徽标，进度条改按累计口径，用户才不会
   * 把「进度从 ~100% 跳回 0%」误读成整理倒退。
   */
  pass: number;
  /** B-19: 之前各趟的书签量之和 —— 累计进度条的基数（当前趟从基数往上加）。 */
  passBase: number;
}

const IDLE: RunState = {
  job: null,
  running: false,
  engine: null,
  modelError: null,
  autoApplied: 0,
  uncovered: 0,
  uncategorized: 0,
  adultQuarantined: 0,
  error: null,
  topics: [],
  autoGrouped: null,
  rebalanceWarning: false,
  applying: false,
  pass: 0,
  passBase: 0,
};

/**
 * Merges per-chunk topic counts into a running total. Topics are de-duplicated
 * by name and summed, so the same topic appearing across chunks accumulates.
 *
 * A-4（审计结论，故意不优化）: 审计建议「topics 只在 finalize/organize 末段聚合一次，
 * run 不再返回 topics」以省每分片的 O(n) 聚合。本实现**保留**每分片的 topics 聚合，原因：
 * 1) 主题分类只发生在服务端 engine（`aggregateTopics`），前端/organize 层拿不到书签级
 *    topic 归属，唯一能累加的入口就是各分片回传的 `result.topics`；
 * 2) 本函数 `mergeTopicCounts` 依赖各分片 topics 做跨分片求和，若 run 不再返回，前端
 *    分布图将无数据来源；
 * 3) 单分片聚合成本几乎可忽略（审计原文也标注「可不做」）。
 * 因此该微优化在现有架构下不划算，保持现状并文档化，避免误删导致图表缺数据。
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
 *  - **Interruptibility.** `stop()` flips `cancelled` and tells the server to
 *    mark the job `cancelled` (B-4). In-flight partitions are deliberately NOT
 *    aborted — they are already paid for, and their proposals land in the queue;
 *    the loop simply stops handing out new partitions and ignores late results.
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
  /**
   * B-4: 当前在跑的任务 ID，供 stop() 通知服务端取消。
   * 客户端 cancelled 只让本地循环停下来，服务端的 ai_jobs 行会永远停在
   * running/finalizing —— 任务历史一直显示「整理中」，且后续 /run 仍会被接受。
   */
  const activeJobId = useRef<string | null>(null);
  /**
   * B-8: 重入守卫。setState 是异步的，快速双击开始按钮（或「先试 20 条」+「开始整理」
   * 连点）可以在重渲染隐藏按钮之前再次进入 start()：两个循环、两个任务、两个 job 行，
   * activeJobId 被后者覆盖，stop() 只能取消后一个，且双倍消耗模型配额。ref 的读写是
   * 同步的，能堵住这个状态异步窗口。
   */
  const runningRef = useRef(false);
  /**
   * B-18（第二轮审计）: 当前 pass 的分片 AbortController 提为 ref。旧实现里 abort 是
   * start() 的局部变量，stop() 与卸载清理够不着它：停止后在途分片继续跑完（服务端
   * 照常计配额），成功返回后还会 setState 把 running 翻回 true（停止按钮短暂重现）；
   * 卸载时在途最多 6 个请求也不会中止。提为 ref 后 stop()/卸载可立即 abort 全部在途。
   */
  const abortRef = useRef<AbortController | null>(null);
  /**
   * B-14: 运行结束后延时自动复位的定时器。结束后 `run.job` 一直非空，导致成本预估
   * （以 `!run.job` 为 enabled 条件）在整个会话里永久失效；到点后把状态复位回 IDLE，
   * 预估块即可重新渲染。新一次 start() 或组件卸载时清除。
   */
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    cancelled.current = true;
    // B-18: 立即中止全部在途分片请求 —— 停止即真停，不再等它们跑完（省配额，
    // 也杜绝迟到分片把 running 翻回 true）。
    abortRef.current?.abort();
    setState((s) => ({ ...s, running: false }));
    // B-4: 同步把服务端任务行转为 cancelled（幂等；端点只在 queued/running 时改状态）。
    // best-effort：网络失败也不阻塞 UI 停止。已写入的建议保留，用户可继续审阅。
    const jobId = activeJobId.current;
    if (jobId) {
      void api.delete(`/ai/jobs/${jobId}`).catch(() => {
        /* 取消是 best-effort：服务端未响应不影响客户端停止 */
      });
    }
  }, []);

  const reset = useCallback(() => {
    clearResetTimer();
    cancelled.current = false;
    setState(IDLE);
  }, [clearResetTimer]);

  // If the user leaves the page mid-run, stop the long-poll loop — otherwise it
  // keeps firing /ai/jobs/:id/run in the background, invalidating caches and
  // setState-ing an unmounted component, burning API quota for nothing.
  useEffect(() => {
    return () => {
      cancelled.current = true;
      // B-18: 卸载即断流 —— 在途分片一并中止，服务端不再为无人等待的请求计配额。
      abortRef.current?.abort();
      clearResetTimer();
    };
  }, [clearResetTimer]);

  const start = useCallback(
    async (
      target: AiJobTarget,
      bookmarkIds?: string[],
      limit?: number,
      kind: 'tagging' | 'categorize' | 'rename' = 'tagging',
      includeBrowserFolder?: boolean,
    ) => {
      // B-8: 重入守卫 —— setState 异步，按钮隐藏前可能被再次点击。
      if (runningRef.current) return null;
      runningRef.current = true;
      clearResetTimer();
      cancelled.current = false;
      setState({ ...IDLE, running: true });

      let job: AiJob | null = null;
      let lastJob: AiJob | null = null;
      let error: string | null = null;
      let autoApplied = 0;
      let uncategorized = 0;
      let adultQuarantined = 0;
      let finalUncovered = 0; // 末趟仍未覆盖的书签数（真正需要人工复核的量）
      // B-2: 致命错误（无效 key / 未知模型）一旦发生，补跑必然同样失败 ——
      // 置位后跳出整个 pass 循环，避免白烧 MAX_PASSES 轮任务与配额。
      let fatal = false;

      // 方案F：未覆盖（域名兜底/分片错误）书签自动补跑。
      // 不原地重放分片——那会让服务端重复计数 processed、破坏收尾判定。改为把这批
      // 书签作为一次全新任务重跑：新任务计数器独立、建议写入幂等（DELETE+INSERT），安全。
      const MAX_PASSES = 2; // 主跑 + 最多 2 次补跑
      let scopeIds: string[] | undefined = bookmarkIds;
      // B-19: 累计进度基数 —— 之前各趟的书签量之和。补跑新建任务后计数器归零，
      // 进度条若只看当前趟会从 ~100% 跳回 0%，被误读为整理倒退；UI 改按
      // (passBase + processed) / (passBase + total) 的累计口径展示。
      let passBase = 0;

      for (let pass = 0; pass <= MAX_PASSES; pass += 1) {
        if (cancelled.current) break;
        // 上一趟的范围成为本趟的累计基数（上一趟的 job 即当前 `job` 变量）。
        if (pass > 0 && job) passBase += job.total;

        // 创建本次任务：首次用原始范围；补跑只针对上一趟未覆盖的书签 ID（target='ids'）。
        try {
          const created = await api.post<{ job: AiJob }>('/ai/jobs', {
            target: pass === 0 ? target : 'ids',
            bookmarkIds: pass === 0 ? bookmarkIds : scopeIds,
            limit,
            kind,
            includeBrowserFolder,
          });
          job = created.job;
        } catch (e) {
          error = error ?? (e instanceof Error ? e.message : '无法创建整理任务');
          break;
        }
        if (!job) break;
        const jobId = job.id;
        activeJobId.current = jobId; // B-4: 供 stop() 通知服务端取消
        // B-19: 同步趟次与累计基数，RunPanel 据此展示「第 N 趟补跑」徽标与累计进度。
        setState((s) => ({ ...s, job, running: true, pass, passBase }));

        // 方案A: 把整理范围切成多个不重叠的分片，用固定并发的 worker 池并行打出
        // 去。每个分片带 {from,to} 认领一段书签，服务端用原子计数推进进度，所以
        // 进度条是实时的、且总时长从「N 个串行 round-trip」降到「约一次模型调用」。
        // 关掉抓取后单分片只剩一次模型调用，稳进 Cloudflare 的 30s 墙钟。
        // 单分片书签数从 6 降到 4（2026-08-31）：切到 deepseek-v4-flash / newapi.uupt.work
        // 后实测仍 ~4.2s/条，6 条分片的模型调用约 25s 加收尾(finalize)直接撞上 28s 客户端
        // 墙而整片超时(截图「还是不得行」，20 条里 1 片 6 条兜底)；降到 4 条后模型调用
        // ≈17s，落在 25s 分区预算内并为 finalize 留 ~8s 余量，客户端 28s 墙不再被顶到。
        // 代价：分片数增多(总耗时略增)，但每片都能在墙内成功返回，不再整片兜底。
        // 服务端重试+JSON自动修复已由 engine.ts 三轨道 *WithRetryAndRepair 提供，此处只缩分区。
        const PARTITION = 4;
        const CONCURRENCY = 6;
        const partitions: Array<{ from: number; to: number }> = [];
        for (let from = 0; from < job.total; from += PARTITION) {
          partitions.push({ from, to: Math.min(from + PARTITION, job.total) });
        }

        // 取消 / 致命错误时让所有在途分片一并中止。
        // B-18: 挂到 ref 上，使 stop()/卸载清理能够立即 abort（旧实现是局部变量，
        // 外部够不着，停止后在途分片照常跑完并可能把 running 翻回 true）。
        const abort = new AbortController();
        abortRef.current = abort;
        const passUncovered = new Set<string>();

        const runPartition = async (part: { from: number; to: number }): Promise<void> => {
          if (cancelled.current || abort.signal.aborted) return;

          let result: AiJobRunResult;
          try {
            // 单分片只做一次模型调用（已关抓取），通常数秒；28s 客户端超时留足余量
            // 且仍低于 Pages Functions 的 30s 墙钟。
            result = await api.post<AiJobRunResult>(
              `/ai/jobs/${jobId}/run`,
              { from: part.from, to: part.to },
              { timeoutMs: 28_000, signal: abort.signal },
            );
          } catch (e) {
            if (cancelled.current || abort.signal.aborted) return;
            // 客户端超时/网络错不再就地重放（会重复计数）；超时通常服务端已处理，
            // 记一条软提示即可，不中止整轮。其余真错误才中止。
            if ((e as { code?: string })?.code === 'timeout') {
              error = error ?? '部分分片超时，已跳过；可重新整理补回';
            } else {
              error = e instanceof Error ? e.message : '整理过程中断';
              abort.abort();
            }
            return;
          }

          autoApplied += result.autoApplied;
          uncategorized += result.uncategorized ?? 0;
          adultQuarantined += result.adultQuarantined ?? 0;
          lastJob = result.job;
          for (const id of result.uncoveredIds ?? []) passUncovered.add(id);

          // 致命（fatal）模型错误：服务端已把任务置 failed，整体中止。
          // B-2: 同时置 fatal，让外层补跑循环直接跳出 —— 补跑用的是同一份配置，
          // 只会把同样的致命错误再犯 MAX_PASSES 次。
          if (result.job.status === 'failed' && result.modelError) {
            error = result.job.error ?? result.modelError;
            fatal = true;
            abort.abort();
          }

          // B-18: stop()/卸载已把 cancelled 置位（并 abort）后，迟到返回的分片
          // 不得再 setState —— 否则会把 stop 刚置的 running:false 翻回 true，
          // 停止按钮短暂重现。
          if (cancelled.current || abort.signal.aborted) return;

          setState((s) => ({
            job: result.job,
            running: true,
            // B-19: 全量重建 state 时同样要带上趟次口径，否则分片进度更新
            // 会把第 521 行写入的 pass/passBase 冲回旧值。
            pass,
            passBase,
            engine: result.engine,
            modelError: result.modelError,
            autoApplied,
            // C-4: 实时未覆盖数取本趟去重集合的大小，而不是各分片 uncovered 的裸累加。
            // 裸累加有两个问题：同一书签在补跑中再次未覆盖会被重复计数；异常分片
            // （run.ts catch 路径）返回 uncovered:0 但携带 uncoveredIds，会被漏计。
            uncovered: passUncovered.size,
            uncategorized,
            adultQuarantined,
            error: result.job.status === 'failed' ? result.job.error : null,
            topics: mergeTopicCounts(s.topics, result.topics),
            autoGrouped: result.autoGrouped ?? s.autoGrouped,
            rebalanceWarning: s.rebalanceWarning || result.rebalanceWarning,
            applying: s.applying,
          }));
        };

        const worker = async (): Promise<void> => {
          for (;;) {
            if (cancelled.current || abort.signal.aborted) return;
            const part = partitions.shift();
            if (!part) return;
            await runPartition(part);
          }
        };

        const workers: Promise<void>[] = [];
        const workerCount = Math.max(1, Math.min(CONCURRENCY, partitions.length));
        for (let i = 0; i < workerCount; i += 1) workers.push(worker());
        await Promise.all(workers);

        // B-4: 取消时若模型推理其实已经全部完成（服务端已置 finalizing），仍然收尾
        // 一次再退出 —— 建议全部落库、finalize 幂等且不含模型调用（约 1 次 D1 批量
        // 写）。直接 break 会把任务永久留在 finalizing：stop() 的取消端点只处理
        // queued/running，finalizing 不在其列，任务历史会一直显示「整理中」。
        const pendingFinalize = lastJob?.status === 'finalizing';
        if (cancelled.current && !pendingFinalize) break;

        // 方案A: 模型推理分片全部完成后，独立调用 /finalize 收尾（auto-apply + 三级归类
        // 重建 + 新标签统计），使单请求不叠加模型推理、不越 30s 墙钟。仅当任务进入
        // finalizing（模型完成、待收尾）时触发；failed/cancelled/未收尾跳过。
        if (pendingFinalize) {
          try {
            setState((s) => ({ ...s, applying: true }));
            const fr = await api.post<AiJobRunResult>(
              `/ai/jobs/${jobId}/finalize`,
              {},
              { signal: abort.signal },
            );
            autoApplied += fr.autoApplied;
            lastJob = fr.job;
            setState((s) => ({
              ...s,
              job: fr.job,
              autoApplied,
              autoGrouped: fr.autoGrouped ?? s.autoGrouped,
              rebalanceWarning: s.rebalanceWarning || fr.rebalanceWarning,
              applying: false,
            }));
          } catch (e) {
            // finalize 失败：幂等可重试，不整轮 abort；建议已落库，可稍后重新整理补回。
            error = error ?? (e instanceof Error ? e.message : '应用整理结果失败');
            setState((s) => ({ ...s, applying: false }));
          }
        }

        // 末趟仍未覆盖的书签数 = 真正需要人工复核的量（避免跨 pass 重复计入）。
        finalUncovered = passUncovered.size;
        // 取消 / 致命错误 / 全覆盖 / 已达补跑上限：停止补跑。
        if (cancelled.current) break;
        if (fatal) break; // B-2: 致命错误补跑必然同样失败，不再新建任务
        if (passUncovered.size === 0) break;
        if (pass === MAX_PASSES) break;
        scopeIds = [...passUncovered];
      }

      // B-4: 本轮已结束，stop() 不应再对一个已收尾/已失败的任务发取消请求。
      activeJobId.current = null;
      // B-18: 同理，本轮的 AbortController 已无在途请求可中止，清掉以免 stop()
      // 误伤下一轮（下一轮 start 会重新赋值）。
      abortRef.current = null;

      if (!job) {
        runningRef.current = false;
        setState({ ...IDLE, error: error ?? '无法创建整理任务' });
        return null;
      }
      lastJob = lastJob ?? job;

      // 用户中途取消或发生错误：取消不算错误；否则带上 error。
      setState((s) => ({
        ...s,
        job: lastJob,
        running: false,
        uncovered: finalUncovered, // 末趟仍未覆盖量（去重），避免多趟累加
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

      // C-1 延伸：此处原有一次 `setState({...s, running:false})` —— 上面的收尾
      // setState 已经把 running 置 false，其间没有任何代码把它翻回 true，
      // 属于纯多余的一次重渲染，删除。

      // B-8: 本轮结束，放行下一次 start()。
      runningRef.current = false;

      // B-14: 运行结束（含停止/失败）后延时自动复位回 IDLE。不复位的话 `run.job`
      // 永久非空，成本预估（`!run.job` 才 enabled）在整个会话里失效，进度条与
      // 提示也长期残留。延时 12s 让用户先看到结果摘要；期间任何新一次运行或
      // 手动重置都会取消这个定时器。
      clearResetTimer();
      resetTimer.current = setTimeout(() => {
        resetTimer.current = null;
        setState(IDLE);
      }, 12_000);

      return job;
    },
    [qc, clearResetTimer],
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

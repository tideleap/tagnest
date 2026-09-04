import type { AiJobRunResult } from '../../../../../shared/types';
import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { conflict, json, notFound } from '../../../../_lib/http';
import { createLogger } from '../../../../_lib/logger';
import {
  RUN_CHUNK_LEGACY,
  aggregateCategoryTopics,
  aggregateTopics,
  categorizeBookmarks,
  claimPartition,
  getJob,
  getEffectiveAiConfig,
  consumeAiCredit,
  incrementJobCounters,
  loadBookmarkInputs,
  loadConfigRow,
  loadFeedbackProfile,
  loadFewShotExamples,
  loadVocabulary,
  makeKvCategoryCache,
  makeKvRenameCache,
  makeKvTagCache,
  renameBookmarks,
  saveCategorySuggestions,
  saveRenameSuggestions,
  saveSuggestions,
  suggestForBookmarks,
  toApiJob,
  toLocalConfig,
  tryMarkFinalizing,
  updateJob,
} from '../../../../_lib/ai';

/**
 * Processes one slice of a run.
 *
 * ## Two drive modes
 *
 * **Cursor mode (legacy, serial).** The client loops, each call processes the
 * next `RUN_CHUNK_LEGACY` bookmarks starting at `job.processed`, and reports `done`
 * when nothing is left. One round trip per 20 bookmarks; survives a reload and
 * is trivially resumable.
 *
 * **Partition mode (方案A, parallel).** The client splits the scope into N
 * disjoint, fixed-size partitions and fires them with `{ from, to }` up to
 * `CONCURRENCY` at a time. Because every partition owns a distinct slice of
 * bookmark IDs, their writes never collide on the same suggestion row, and a
 * single atomic `UPDATE ... SET processed = processed + ?` lets the LAST
 * partition that lands detect "I am the finisher" by checking
 * `processed >= total` after its own increment. The net effect: a 168-bookmark
 * run that used to take ~9 serial round trips (each liable to blow the 30s
 * Cloudflare Functions wall-clock because categorize fetched every page body)
 * now finishes in roughly one model-call's worth of wall time, with live
 * progress stitched from the atomic counter.
 *
 * ## Failure policy
 *
 * A model failure is not a job failure. `categorizeBookmarks` / `suggestForBookmarks`
 * degrade to the domain-derived fallback and report why; the slice still
 * produces proposals and the run continues. Only a *fatal* condition (bad key,
 * unknown model) stops the run, because otherwise every remaining partition
 * would burn a round trip to fail the same way.
 *
 * ## Why finalize runs on a separate endpoint
 *
 * `autoApply` / `autoApplyCategories` / `applyTagHierarchy` rewrite shared
 * state (the user's tag tree, accepted suggestions). They are expensive and,
 * under a slow gateway + a large scope, can push the finisher's `/run` past the
 * Cloudflare 30s wall-clock (the 503 the user hit on a 169-bookmark run).
 * 方案A therefore strips finalize OUT of `/run`: each `/run` only does model
 * inference (capped by `partitionBudgetMs`), and the finisher marks the job
 * `finalizing` instead of `done`. The client then calls the dedicated
 * `/api/ai/jobs/:id/finalize` once, which owns its own 30s budget and applies
 * the shared-state work safely. Finalize is idempotent, so a retry is safe.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const jobId = String(ctx.params.id);
  const log = createLogger(ctx.env);

  const job = await getJob(ctx.env, userId, jobId);
  if (!job) throw notFound('整理任务不存在');

  if (job.status === 'cancelled') throw conflict('该整理任务已取消');
  if (job.status === 'failed') throw conflict(job.error ?? '该整理任务已失败');

  const ids = job.scope?.ids ?? [];

  // 方案A: 客户端把整理拆成多个并行分片，每个分片带 {from,to} 认领一段不重叠的
  // 书签区间；服务端用原子计数推进进度，最后一个分片收尾置 finalizing（交由
  // /finalize 完成收尾）。不带 body 时回退到旧游标串行模式（兼容续跑 / 老调用方）。
  let body: { from?: unknown; to?: unknown } = {};
  try {
    const raw = await ctx.request.json().catch(() => null);
    if (raw && typeof raw === 'object') body = raw as { from?: unknown; to?: unknown };
  } catch {
    body = {};
  }
  const usePartition = typeof body.from === 'number' && typeof body.to === 'number';

  let slice: string[];
  if (usePartition) {
    const from = Math.max(0, Math.floor(body.from as number));
    const to = Math.min(ids.length, Math.max(from, Math.floor(body.to as number)));
    slice = ids.slice(from, to);

    // B-17（第二轮审计）: 服务端分片幂等闸门。{from,to} 由客户端声明，重放同一
    // 分片会让 `processed` 重复累加（可能提前触发 finalizing，此时其它分片建议
    // 尚未落库，auto-apply 不完整）并重复扣费。以 (job, from) 为主键原子认领：
    // 首个认领者继续处理，重放者直接返回当前任务快照，不再推理、不再计费。
    // 游标(串行)模式不带 from，天然不受此闸门影响（其幂等性由 processed 游标保证）。
    if (slice.length > 0) {
      const claimed = await claimPartition(ctx.env, jobId, from, to);
      if (!claimed) {
        log.info('ai.job.partition_replay', { userId, jobId, from, to });
        const current = (await getJob(ctx.env, userId, jobId)) ?? job;
        const result: AiJobRunResult = {
          job: toApiJob(current),
          done: false,
          suggested: 0,
          autoApplied: 0,
          rebalanceWarning: false,
          uncovered: 0,
          engine: 'none',
          modelError: null,
        };
        return json(result);
      }
    }
  } else {
    slice = ids.slice(job.processed, job.processed + RUN_CHUNK_LEGACY);
  }

  // Nothing to process.
  if (slice.length === 0) {
    // 并行模式下空分片视为异常（客户端不应发到），不打 finalizing，交给其它分片收尾；
    // 直接复用本请求开头已读取的 job（line 82），不再查库（E3：去掉冗余 getJob）。
    if (job.status !== 'done' && !usePartition) {
      // 仅游标(串行)模式再读一次，确认是否已被其它调用方推进到末位；同一请求内仅此一次额外读。
      const settled = await getJob(ctx.env, userId, jobId);
      const current = settled ?? job;
      const done = current.processed >= ids.length;
      // 方案A: 游标(串行)模式收尾同样置 finalizing，交由 /finalize 完成收尾。
      // B-2（第二轮审计）: 改用原子条件转移，排除已 failed/cancelled 的任务
      // （此前此处无守卫，可把终态任务复活成 finalizing）。
      let finalJob = current;
      if (done) {
        const acquired = await tryMarkFinalizing(ctx.env, userId, jobId);
        if (acquired) {
          // 复用 current（置 finalizing 后就地合并状态），彻底去掉原先紧跟其后的第二次查库。
          finalJob = { ...current, status: 'finalizing' } as typeof current;
        } else {
          // 未抢到收尾权（任务已终态）：重读最新状态返回。
          finalJob = (await getJob(ctx.env, userId, jobId)) ?? current;
        }
      }
      const result: AiJobRunResult = {
        job: toApiJob(finalJob),
        done: finalJob.processed >= ids.length,
        suggested: 0,
        autoApplied: 0,
        rebalanceWarning: false,
        uncovered: 0,
        engine: 'none',
        modelError: null,
      };
      return json(result);
    }
    const result: AiJobRunResult = {
      job: toApiJob(job),
      done: false,
      suggested: 0,
      autoApplied: 0,
      rebalanceWarning: false,
      uncovered: 0,
      engine: 'none',
      modelError: null,
    };
    return json(result);
  }

  // 方案A 失败隔离：单个分片在「模型调用 + D1 写入」任意环节抛出非预期异常
  // （并发下的 D1 SQLITE_BUSY / 连接器重置等，表现为 500 "服务器内部错误"）时，
  // 不让异常冒泡成整轮 /run 的 500 —— 否则客户端 organize.ts 的 abort.abort()
  // 会连带杀掉其它在途分片，整轮整理全废。改为：记录错误、把本分片计为已处理
  // (含失败)、返回 200 + modelError，让其它分片继续、收尾分片仍能正常收口(finalizing)。
  // 受影响书签仅本轮拿不到建议，可重新整理补回，而不是全盘失败。
  try {
  // 分片起止计时基准（D-2）：用于 ai.job.chunk 日志的 partitionMs，便于在
  // 慢网关下调参（观察单分片墙钟占用是否逼近 budgetMs）。
  const sliceStart = Date.now();
  // 每个分片独立把 queued 翻成 running（幂等，重复调用无副作用）。
  if (job.status === 'queued') {
    await updateJob(ctx.env, userId, jobId, { status: 'running' });
  }

  // Config is re-read per slice on purpose: changing the model or the tag
  // budget mid-run takes effect on the next slice instead of being frozen at
  // job creation.
  // 方案A 性能(A-1): 配置行只读取一次（含解密 API key），复用同一 row 推导
  // local 与 effective，避免 getEffectiveAiConfig 内部二次读库/解密——并行 6
  // 分片下每趟原 18 次 ai_settings 读 + 18 次解密，现降为 6 次，释放 25s 分区
  // 预算给模型调用（详见 billing.ts getEffectiveAiConfig 注释）。
  const row = await loadConfigRow(ctx.env, userId);
  const local = toLocalConfig(row);
  const effective = await getEffectiveAiConfig(ctx.env, userId, row);
  const config = effective?.config ?? null;

  // Vocabulary is also re-read per slice, so tags accepted from the previous
  // slice are already part of the taxonomy the next slice normalises against.
  // That is what stops a long run from inventing "前端" and "Frontend" in two
  // different slices of the same job.
  //
  // A-2（审计结论，故意不优化）: 曾考虑把 vocab / feedback 提到分片循环外只读一次
  // 以省 2 次 D1 查询。**否决** —— 每个分片是独立的 HTTP 请求，"循环外"并不存在；
  // 而在同一请求内它们本就只读一次。跨分片共享则会冻结词表，正是上面这条归一化
  // 保证要避免的（并行 6 分片下 A、B 两片会各自造出 "前端"/"Frontend"）。
  // 正确性优先于这 2 次查询；A-1 已把更贵的配置解密从 3 次降到 1 次。
  const vocab = await loadVocabulary(ctx.env, userId);
  // Load the user's accept/reject history so this slice's proposals are bent by
  // what they have accepted or rejected before (the "越用越准" loop).
  const feedback = await loadFeedbackProfile(ctx.env, userId);

  // 方案A 收尾：单个分片必须在自己的硬预算内完成模型调用（含重试），否则会被
  // Cloudflare Pages Functions 的 ~30s 墙钟杀掉、而客户端 28s 超时先触发，表现为
  // "0/168 + 请求超时"。该信号在 providers.withDeadline 中与每次调用的
  // REQUEST_TIMEOUT_MS 取较小值，保证无论后者如何配置都不会突破墙钟。
  // `TN_PARTITION_BUDGET_MS` 可调（默认 25s，给 D1 写入留余量，finalize 已剥离）。
  // 25s = 8s 抓取上限 + 15s 模型底线 + ~2s 固定开销（D1 查询/缓存/提示词构建）。
  const partitionBudgetMs = Math.max(5_000, Number(ctx.env.TN_PARTITION_BUDGET_MS) || 25_000);
  const partitionSignal = AbortSignal.timeout(partitionBudgetMs);

  const inputs = await loadBookmarkInputs(ctx.env, userId, slice);
  // Anything that vanished between snapshot and now (trashed, deleted) counts
  // as processed-but-failed rather than silently shrinking the total.
  const missing = slice.length - inputs.length;

  /**
   * Atomically advances the job counters for this slice, then decides whether
   * this slice is the finisher. Returns the freshly-read job and that flag.
   * The finisher is the only slice permitted to mark the job `finalizing`
   * (modeling complete, awaiting the separate finalize endpoint).
   */
  const commit = async (
    counts: { processed: number; suggested: number; failed: number },
    fatal: boolean,
    error: string | null,
  ): Promise<{ finalJob: NonNullable<Awaited<ReturnType<typeof getJob>>>; isFinal: boolean }> => {
    await incrementJobCounters(ctx.env, userId, jobId, {
      processed: counts.processed,
      suggested: counts.suggested,
      failed: counts.failed,
      ...(fatal ? { status: 'failed', error } : {}),
    });
    const updated = (await getJob(ctx.env, userId, jobId)) ?? job;
    const total = updated.total ?? ids.length;
    // 方案A + B-2/B-6（第二轮审计）: 收尾收敛为原子条件转移。
    // 仅当本分片非致命、计数已达 total 时尝试置 finalizing；tryMarkFinalizing
    // 内部以 `status IN ('queued','running')` 为前置条件单语句 UPDATE，天然
    // 排除已 failed / cancelled 的任务（第一轮 B-1 的守卫），并消除读-写之间
    // 的 TOCTOU 窗口（B-6：DELETE 取消不再可能被末片覆盖回 finalizing）。
    // 转移失败（任务已被置终态）则放弃收尾，返回最新快照。
    const shouldFinalize = !fatal && updated.processed >= total;
    if (shouldFinalize) {
      const acquired = await tryMarkFinalizing(ctx.env, userId, jobId);
      if (acquired) {
        // 刚置 finalizing，直接在返回对象上合并状态即可，省一次 D1 查询。
        return { finalJob: { ...updated, status: 'finalizing' }, isFinal: true };
      }
      // 未抢到收尾权（任务已 failed/cancelled/finalizing/done）：重读最新状态返回。
      const latest = (await getJob(ctx.env, userId, jobId)) ?? updated;
      return { finalJob: latest, isFinal: false };
    }
    return { finalJob: updated as NonNullable<Awaited<ReturnType<typeof getJob>>>, isFinal: false };
  };

  // ---- CategorySync: the categorize track shares the job loop but writes
  // single placements instead of loose labels. Everything above (snapshot,
  // slicing, config re-read) is identical; only the engine + persistence differ.
  if (job.kind === 'categorize') {
    const outcome = await categorizeBookmarks(inputs, {
      vocab,
      config,
      feedback,
      categoryCache: ctx.env.AI_CACHE ? makeKvCategoryCache(ctx.env.AI_CACHE) : undefined,
      signal: partitionSignal,
      // D-3: 与打标轨道一致透传分区预算，超时诊断才不会因 budget=0 误判
      // 「网页抓取挤占模型时间」（本轨道根本不抓取网页）。
      partitionBudgetMs,
    });

    const written = await saveCategorySuggestions(ctx.env, userId, jobId, outcome.results);

    // Meter the hosted tier per bookmark analysed; best-effort.
    // B-12（第二轮审计）: 按实际分析数计费。inputs 已排除 missing（快照后消失的
    // 书签），再扣除 adultQuarantined（隔离的成人内容书签从未送模型、不耗 token）。
    // 口径「1 credit = 1 bookmark analysed」由此对得上。
    if (effective?.managed && outcome.engine === 'model') {
      try {
        const analysed = Math.max(0, inputs.length - (outcome.adultQuarantined ?? 0));
        await consumeAiCredit(ctx.env, userId, analysed, 'ai.job.categorize', jobId);
      } catch {
        /* meter is best-effort */
      }
    }

    const { finalJob, isFinal } = await commit(
      { processed: slice.length, suggested: written, failed: missing },
      Boolean(outcome.fatal),
      outcome.fatal ? outcome.modelError : null,
    );

    // C-6: 收尾（autoApplyCategories / 新标签统计）在 /finalize —— 理由见文件头
    // "Why finalize runs on a separate endpoint"，此处不再复述。

    log.info('ai.job.chunk', {
      userId,
      jobId,
      kind: 'categorize',
      partition: usePartition,
      processed: finalJob.processed,
      total: ids.length,
      suggested: written,
      uncategorized: outcome.uncategorized,
      engine: outcome.engine,
      fatal: outcome.fatal,
      partitionMs: Date.now() - sliceStart,
      budgetMs: partitionBudgetMs,
    });

    const result: AiJobRunResult = {
      job: toApiJob(finalJob),
      done: isFinal,
      suggested: written,
      autoApplied: 0,
      rebalanceWarning: false,
      uncovered: outcome.uncovered,
      uncoveredIds: outcome.uncoveredIds,
      uncategorized: outcome.uncategorized,
      adultQuarantined: outcome.adultQuarantined,
      engine: outcome.engine,
      modelError: outcome.modelError,
      topics: aggregateCategoryTopics(outcome.results),
    };
    return json(result);
  }

  // ---- Rename track (structured-organise Phase B): conservative title
  // cleanup. Same job loop, but the engine needs neither vocabulary nor
  // feedback (no tree to normalise against) and there is no auto-apply — title
  // changes always wait for review.
  if (job.kind === 'rename') {
    const outcome = await renameBookmarks(inputs, {
      config,
      renameCache: ctx.env.AI_CACHE ? makeKvRenameCache(ctx.env.AI_CACHE) : undefined,
      signal: partitionSignal,
      // D-3: 与打标轨道一致透传分区预算，超时诊断三轨道口径统一。
      partitionBudgetMs,
    });

    const written = await saveRenameSuggestions(ctx.env, userId, jobId, outcome.results);

    // Meter the hosted tier per bookmark analysed; best-effort.
    // B-12（第二轮审计）: 同 categorize 轨道——按实际送模型的数量计费。
    if (effective?.managed && outcome.engine === 'model') {
      try {
        const analysed = Math.max(0, inputs.length - (outcome.adultQuarantined ?? 0));
        await consumeAiCredit(ctx.env, userId, analysed, 'ai.job.rename', jobId);
      } catch {
        /* meter is best-effort */
      }
    }

    const { finalJob, isFinal } = await commit(
      { processed: slice.length, suggested: written, failed: missing },
      Boolean(outcome.fatal),
      outcome.fatal ? outcome.modelError : null,
    );

    log.info('ai.job.chunk', {
      userId,
      jobId,
      kind: 'rename',
      partition: usePartition,
      processed: finalJob.processed,
      total: ids.length,
      suggested: written,
      unchanged: outcome.unchanged,
      engine: outcome.engine,
      fatal: outcome.fatal,
      partitionMs: Date.now() - sliceStart,
      budgetMs: partitionBudgetMs,
    });

    const result: AiJobRunResult = {
      job: toApiJob(finalJob),
      done: isFinal,
      suggested: written,
      autoApplied: 0,
      rebalanceWarning: false,
      uncovered: 0,
      adultQuarantined: outcome.adultQuarantined,
      engine: outcome.engine,
      modelError: outcome.modelError,
    };
    return json(result);
  }

  // ---- Tagging track (legacy behaviour, unchanged shape) ----

  // 方案B: few-shot examples from the user's own well-tagged bookmarks. Loaded
  // once per slice (cheap, capped at 4 rows) so a long run keeps teaching the
  // model the user's style on every batch.
  const examples = (await loadFewShotExamples(ctx.env, userId)).map((row) => ({
    title: row.title,
    url: row.url,
    description: row.description ?? undefined,
    tags: row.tags.map((name) => ({ name, reason: '用户已标注' })),
  }));

  const outcome = await suggestForBookmarks(inputs, {
    vocab,
    config,
    local,
    feedback,
    examples,
    tagCache: ctx.env.AI_CACHE ? makeKvTagCache(ctx.env.AI_CACHE) : undefined,
    signal: partitionSignal,
    partitionBudgetMs,
  });

  const written = await saveSuggestions(ctx.env, userId, jobId, outcome.results);

  // Meter the hosted tier per bookmark analysed; best-effort.
  // B-12（第二轮审计）: 同 categorize 轨道——按实际送模型的数量计费。
  if (effective?.managed && outcome.engine === 'model') {
    try {
      const analysed = Math.max(0, inputs.length - (outcome.adultQuarantined ?? 0));
      await consumeAiCredit(ctx.env, userId, analysed, 'ai.job.tagging', jobId);
    } catch {
      /* meter is best-effort */
    }
  }

  const { finalJob, isFinal } = await commit(
    { processed: slice.length, suggested: written, failed: missing },
    Boolean(outcome.fatal),
    outcome.fatal ? outcome.modelError : null,
  );

  // C-6: 收尾（autoApply / applyTagHierarchy / 新标签统计）在 /finalize —— 理由见
  // 文件头 "Why finalize runs on a separate endpoint"。因此本响应里的
  // autoApplied / autoGrouped / rebalanceWarning 恒为空值，由 /finalize 产出。

  log.info('ai.job.chunk', {
    userId,
    jobId,
    partition: usePartition,
    processed: finalJob.processed,
    total: ids.length,
    suggested: written,
    engine: outcome.engine,
    fatal: outcome.fatal,
    partitionMs: Date.now() - sliceStart,
    budgetMs: partitionBudgetMs,
  });

  const result: AiJobRunResult = {
    job: toApiJob(finalJob),
    done: isFinal,
    suggested: written,
    autoApplied: 0,
    rebalanceWarning: false,
    uncovered: outcome.uncovered,
    uncoveredIds: outcome.uncoveredIds,
    adultQuarantined: outcome.adultQuarantined,
    engine: outcome.engine,
    modelError: outcome.modelError,
    topics: aggregateTopics(outcome.results),
    autoGrouped: undefined,
  };

  return json(result);
  } catch (e) {
    // 非预期异常兜底：优雅降级，避免整轮 500。
    const msg = e instanceof Error ? e.message : String(e);
    log.error('ai.job.partition_failed', { userId, jobId, partition: usePartition, error: msg });
    // 推进计数器，使收尾分片仍能触发 finalize，避免整轮卡在 running。
    // A-3: 计数后读到的 job 快照复用给响应体，不再第二次查库（原先连续两次
    // getJob 只为拿同一行；异常路径也在 25s 分区预算内，能省就省）。
    let recovered: Awaited<ReturnType<typeof getJob>> = null;
    try {
      await incrementJobCounters(ctx.env, userId, jobId, {
        processed: slice.length,
        failed: slice.length,
      });
      // 方案A: 若该失败分片恰是末片（计数后已抵 total），把任务标为 finalizing，
      // 使前端仍能触发 /finalize 收尾（建议已落库），避免整轮卡在 running。
      // B-2（第二轮审计）: 改用原子条件转移。此前此处直接 updateJob 置
      // finalizing，无 failed/cancelled 守卫——若另一分片已把任务置 failed，
      // 本路径会把致命错误复活成 finalizing 并触发 auto-apply。
      const after = (await getJob(ctx.env, userId, jobId)) ?? job;
      if (after.processed >= (after.total ?? ids.length)) {
        const acquired = await tryMarkFinalizing(ctx.env, userId, jobId);
        if (acquired) {
          // 刚置 finalizing，就地合并状态即可，无需回查。
          recovered = { ...after, status: 'finalizing' };
        } else {
          // 未抢到收尾权（任务已终态）：重读最新状态返回。
          recovered = (await getJob(ctx.env, userId, jobId)) ?? after;
        }
      } else {
        recovered = after;
      }
    } catch {
      /* 计数器本身也失败则放弃，其它分片会补齐 */
    }
    const failedJob = recovered ?? job;
    const result: AiJobRunResult = {
      job: toApiJob(failedJob),
      done: false,
      suggested: 0,
      autoApplied: 0,
      rebalanceWarning: false,
      uncovered: 0,
      uncoveredIds: slice,
      engine: 'none',
      modelError: '服务器内部错误，该分片已跳过（其余分片继续）。可稍后重新整理补回本分片书签。',
    };
    return json(result);
  }
};

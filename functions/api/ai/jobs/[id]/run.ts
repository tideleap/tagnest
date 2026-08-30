import type { AiJobRunResult, AutoGroupResult } from '../../../../../shared/types';
import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { conflict, json, notFound } from '../../../../_lib/http';
import { createLogger } from '../../../../_lib/logger';
import {
  RUN_CHUNK,
  aggregateCategoryTopics,
  aggregateTopics,
  autoApply,
  autoApplyCategories,
  applyTagHierarchy,
  categorizeBookmarks,
  countJobNewTags,
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
  shouldWarnRebalance,
  suggestForBookmarks,
  toApiJob,
  toLocalConfig,
  updateJob,
} from '../../../../_lib/ai';

/**
 * Processes one slice of a run.
 *
 * ## Two drive modes
 *
 * **Cursor mode (legacy, serial).** The client loops, each call processes the
 * next `RUN_CHUNK` bookmarks starting at `job.processed`, and reports `done`
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
 * ## Why finalize runs once, on the finisher
 *
 * `autoApply` / `autoApplyCategories` / `applyTagHierarchy` rewrite shared
 * state (the user's tag tree, accepted suggestions). Under concurrency they
 * must run exactly once — on the partition that observes `processed >= total`
 * — not per slice, or two finishers could double-apply. The finisher is
 * guaranteed to be the last slice to complete, so by the time it runs, every
 * other partition's suggestions are already committed.
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
  // 书签区间；服务端用原子计数推进进度，最后一个分片收尾置 done。不带 body 时
  // 回退到旧游标串行模式（兼容续跑 / 老调用方）。
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
  } else {
    slice = ids.slice(job.processed, job.processed + RUN_CHUNK);
  }

  // Nothing to process.
  if (slice.length === 0) {
    if (job.status !== 'done' && !usePartition) {
      const settled = await getJob(ctx.env, userId, jobId);
      const done = (settled?.processed ?? job.processed) >= ids.length;
      if (done) await updateJob(ctx.env, userId, jobId, { status: 'done' });
    }
    const finalJob = (await getJob(ctx.env, userId, jobId)) ?? job;
    const result: AiJobRunResult = {
      job: toApiJob(finalJob),
      // 并行模式下空分片视为异常（客户端不应发到），不打 done，交给其它分片收尾。
      done: usePartition ? false : (finalJob.processed ?? 0) >= ids.length,
      suggested: 0,
      autoApplied: 0,
      rebalanceWarning: false,
      uncovered: 0,
      engine: 'none',
      modelError: null,
    };
    return json(result);
  }

  // 每个分片独立把 queued 翻成 running（幂等，重复调用无副作用）。
  if (job.status === 'queued') {
    await updateJob(ctx.env, userId, jobId, { status: 'running' });
  }

  // Config is re-read per slice on purpose: changing the model or the tag
  // budget mid-run takes effect on the next slice instead of being frozen at
  // job creation.
  const row = await loadConfigRow(ctx.env, userId);
  const local = toLocalConfig(row);
  const effective = await getEffectiveAiConfig(ctx.env, userId);
  const config = effective?.config ?? null;

  // Vocabulary is also re-read per slice, so tags accepted from the previous
  // slice are already part of the taxonomy the next slice normalises against.
  // That is what stops a long run from inventing "前端" and "Frontend" in two
  // different slices of the same job.
  const vocab = await loadVocabulary(ctx.env, userId);
  // Load the user's accept/reject history so this slice's proposals are bent by
  // what they have accepted or rejected before (the "越用越准" loop).
  const feedback = await loadFeedbackProfile(ctx.env, userId);

  // 方案A 收尾：单个分片必须在自己的硬预算内完成模型调用（含重试），否则会被
  // Cloudflare Pages Functions 的 ~30s 墙钟杀掉、而客户端 28s 超时先触发，表现为
  // "0/168 + 请求超时"。该信号在 providers.withDeadline 中与每次调用的
  // REQUEST_TIMEOUT_MS 取较小值，保证无论后者如何配置都不会突破墙钟。
  // `TN_PARTITION_BUDGET_MS` 可调（默认 22s，给 D1 写入与收尾 finalize 留余量）。
  const partitionBudgetMs = Math.max(5_000, Number(ctx.env.TN_PARTITION_BUDGET_MS) || 22_000);
  const partitionSignal = AbortSignal.timeout(partitionBudgetMs);

  const inputs = await loadBookmarkInputs(ctx.env, userId, slice);
  // Anything that vanished between snapshot and now (trashed, deleted) counts
  // as processed-but-failed rather than silently shrinking the total.
  const missing = slice.length - inputs.length;

  /**
   * Atomically advances the job counters for this slice, then decides whether
   * this slice is the finisher. Returns the freshly-read job and that flag.
   * The finisher is the only slice permitted to run the shared-state finalize
   * (auto-apply / hierarchy rebuild).
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
    const isFinal = !fatal && updated.processed >= total;
    if (isFinal) {
      await updateJob(ctx.env, userId, jobId, { status: 'done' });
      const reread = await getJob(ctx.env, userId, jobId);
      return { finalJob: (reread ?? updated) as NonNullable<Awaited<ReturnType<typeof getJob>>>, isFinal: true };
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
    });

    const written = await saveCategorySuggestions(ctx.env, userId, jobId, outcome.results);

    // Meter the hosted tier per bookmark analysed; best-effort.
    if (effective?.managed && outcome.engine === 'model') {
      try {
        await consumeAiCredit(ctx.env, userId, slice.length, 'ai.job.categorize', jobId);
      } catch {
        /* meter is best-effort */
      }
    }

    const { finalJob, isFinal } = await commit(
      { processed: slice.length, suggested: written, failed: missing },
      Boolean(outcome.fatal),
      outcome.fatal ? outcome.modelError : null,
    );

    // Finalize once, on the finisher: apply high-confidence placements and
    // measure how much NEW taxonomy this run introduced (advisory rebalance).
    let autoApplied = 0;
    let rebalanceWarning = false;
    if (isFinal && !outcome.fatal) {
      try {
        autoApplied = await autoApplyCategories(ctx.env, userId, local.autoApplyThreshold, jobId);
      } catch (e) {
        log.error('ai.job.autoapply', {
          userId,
          jobId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      try {
        const { newTags, existingTags } = await countJobNewTags(ctx.env, userId, jobId);
        rebalanceWarning = shouldWarnRebalance(newTags, existingTags);
      } catch (e) {
        log.error('ai.job.rebalance', {
          userId,
          jobId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    log.info('ai.job.chunk', {
      userId,
      jobId,
      kind: 'categorize',
      partition: usePartition,
      processed: finalJob.processed,
      total: ids.length,
      suggested: written,
      autoApplied,
      uncategorized: outcome.uncategorized,
      engine: outcome.engine,
      fatal: outcome.fatal,
    });

    const result: AiJobRunResult = {
      job: toApiJob(finalJob),
      done: isFinal || Boolean(outcome.fatal),
      suggested: written,
      autoApplied,
      rebalanceWarning,
      uncovered: outcome.uncovered,
      uncategorized: outcome.uncategorized,
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
    });

    const written = await saveRenameSuggestions(ctx.env, userId, jobId, outcome.results);

    // Meter the hosted tier per bookmark analysed; best-effort.
    if (effective?.managed && outcome.engine === 'model') {
      try {
        await consumeAiCredit(ctx.env, userId, slice.length, 'ai.job.rename', jobId);
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
    });

    const result: AiJobRunResult = {
      job: toApiJob(finalJob),
      done: isFinal || Boolean(outcome.fatal),
      suggested: written,
      autoApplied: 0,
      rebalanceWarning: false,
      uncovered: 0,
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
  });

  const written = await saveSuggestions(ctx.env, userId, jobId, outcome.results);

  // Meter the hosted tier per bookmark analysed; best-effort.
  if (effective?.managed && outcome.engine === 'model') {
    try {
      await consumeAiCredit(ctx.env, userId, slice.length, 'ai.job.tagging', jobId);
    } catch {
      /* meter is best-effort */
    }
  }

  const { finalJob, isFinal } = await commit(
    { processed: slice.length, suggested: written, failed: missing },
    Boolean(outcome.fatal),
    outcome.fatal ? outcome.modelError : null,
  );

  // Finalize once, on the finisher: auto-apply, sync the three-level hierarchy,
  // and measure new-taxonomy share. All operate on shared state, so they must
  // not run per slice.
  let autoApplied = 0;
  let autoGrouped: AutoGroupResult | undefined;
  let rebalanceWarning = false;
  if (isFinal && !outcome.fatal) {
    try {
      autoApplied = await autoApply(ctx.env, userId, local.autoApplyThreshold, jobId);
    } catch (e) {
      log.error('ai.job.autoapply', {
        userId,
        jobId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      autoGrouped = await applyTagHierarchy(ctx.env.DB, userId);
    } catch (e) {
      log.error('ai.job.grouping', {
        userId,
        jobId,
        error: e instanceof Error ? e.message : String(e),
      });
      // Grouping failure is not fatal to the run: proposals are already saved.
    }
    try {
      const { newTags, existingTags } = await countJobNewTags(ctx.env, userId, jobId);
      rebalanceWarning = shouldWarnRebalance(newTags, existingTags);
    } catch (e) {
      log.error('ai.job.rebalance', {
        userId,
        jobId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  log.info('ai.job.chunk', {
    userId,
    jobId,
    partition: usePartition,
    processed: finalJob.processed,
    total: ids.length,
    suggested: written,
    autoApplied,
    autoGrouped: autoGrouped
      ? { created: autoGrouped.createdCategories, relocated: autoGrouped.relocated }
      : null,
    engine: outcome.engine,
    fatal: outcome.fatal,
  });

  const result: AiJobRunResult = {
    job: toApiJob(finalJob),
    done: isFinal || Boolean(outcome.fatal),
    suggested: written,
    autoApplied,
    rebalanceWarning,
    uncovered: outcome.uncovered,
    engine: outcome.engine,
    modelError: outcome.modelError,
    topics: aggregateTopics(outcome.results),
    autoGrouped,
  };

  return json(result);
};

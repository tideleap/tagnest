import type { AiJobRunResult, AutoGroupResult } from '../../../../../shared/types';
import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { conflict, json, notFound } from '../../../../_lib/http';
import { createLogger } from '../../../../_lib/logger';
import {
  autoApply,
  autoApplyCategories,
  applyTagHierarchy,
  countJobNewTags,
  getJob,
  loadConfigRow,
  shouldWarnRebalance,
  toApiJob,
  toLocalConfig,
  updateJob,
} from '../../../../_lib/ai';

/**
 * 方案A: finalize 从 /run 末片剥离到本独立端点，使 /run 只做模型推理
 * （≤ partitionBudgetMs 25s 分区预算，留 <30s 墙钟裕量）。本端点独占一次
 * 请求预算（169 条 ≈12s）收尾：auto-apply + 三级归类重建 + 新标签统计，
 * 在自身 30s 墙内安全完成，不再与模型推理叠加顶破墙钟（即用户遇到的 503）。
 *
 * 幂等：status 已为 done 时直接返回成功（auto-apply 基于 suggestions 幂等，
 * 重跑无害）；仅当 status 为 finalizing（模型推理完成、待收尾）才执行收尾并置 done。
 * queued / running / cancelled / failed 不允许进入收尾。
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const jobId = String(ctx.params.id);
  const log = createLogger(ctx.env);

  const job = await getJob(ctx.env, userId, jobId);
  if (!job) throw notFound('整理任务不存在');

  // 仅模型推理完成(finalizing)或已收尾(done)允许进入 finalize；
  // queued/running 表示还有分片在途，cancelled/failed 不应收尾。
  if (job.status !== 'finalizing' && job.status !== 'done') {
    throw conflict(`当前状态（${job.status}）不支持收尾`);
  }

  // C-2: 已 done 的任务直接返回成功，不重跑收尾。
  // 重跑本身是安全的（autoApply 只挑 status='pending' 的建议，applyTagHierarchy
  // 按名查重 + parentId 等值跳过，都是幂等的），但它会白花一次「auto-apply 全量
  // 扫描 + 整棵标签树重建」—— 大库上这是收尾里最贵的一段，而结果必然是
  // autoApplied = 0。重复调用只可能来自客户端重试/双击，因此在此短路。
  if (job.status === 'done') {
    const already: AiJobRunResult = {
      job: toApiJob(job),
      done: true,
      suggested: 0,
      autoApplied: 0,
      rebalanceWarning: false,
      uncovered: 0,
      engine: 'none',
      modelError: null,
    };
    return json(already);
  }

  let autoApplied = 0;
  let autoGrouped: AutoGroupResult | undefined;
  let rebalanceWarning = false;
  let modelError: string | null = null;
  // B-16: auto-apply is the one step whose failure must NOT be papered over by
  // marking the job done. If it throws, the job stays `finalizing` so a retry
  // of /finalize actually re-runs it — otherwise the 「可重试」 message is a lie
  // (the done short-circuit above would skip auto-apply forever).
  let autoApplyFailed = false;

  try {
    if (job.kind === 'tagging') {
      const row = await loadConfigRow(ctx.env, userId);
      const local = toLocalConfig(row);
      try {
        autoApplied = await autoApply(ctx.env, userId, local.autoApplyThreshold, jobId);
      } catch (e) {
        log.error('ai.job.autoapply', {
          userId,
          jobId,
          error: e instanceof Error ? e.message : String(e),
        });
        modelError = '标签自动应用失败，建议已保存，可重试收尾';
        autoApplyFailed = true;
      }
      try {
        autoGrouped = await applyTagHierarchy(ctx.env.DB, userId);
      } catch (e) {
        log.error('ai.job.grouping', {
          userId,
          jobId,
          error: e instanceof Error ? e.message : String(e),
        });
        // Grouping failure is not fatal to finalize: proposals are already saved.
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
    } else if (job.kind === 'categorize') {
      const row = await loadConfigRow(ctx.env, userId);
      const local = toLocalConfig(row);
      try {
        autoApplied = await autoApplyCategories(ctx.env, userId, local.autoApplyThreshold, jobId);
      } catch (e) {
        log.error('ai.job.autoapply', {
          userId,
          jobId,
          error: e instanceof Error ? e.message : String(e),
        });
        modelError = '分类自动应用失败，建议已保存，可重试收尾';
        autoApplyFailed = true;
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
    // rename 无 auto-apply / 建组，仅置 done。

    // B-16: auto-apply 失败时不置 done —— 任务停留 finalizing，重试 /finalize 才会
    // 真正重跑 auto-apply（done 会被上面的短路跳过）。其余步骤（建组/统计）失败不阻塞。
    if (autoApplyFailed) {
      const retryJob = (await getJob(ctx.env, userId, jobId)) ?? job;
      const result: AiJobRunResult = {
        job: toApiJob(retryJob),
        done: false,
        suggested: 0,
        autoApplied,
        rebalanceWarning,
        uncovered: 0,
        engine: 'none',
        modelError,
        autoGrouped,
      };
      return json(result);
    }

    // 到这里 status 必为 finalizing（done 已在上面短路），无条件置 done。
    await updateJob(ctx.env, userId, jobId, { status: 'done' });
  } catch (e) {
    // C-6: 不把原始异常消息回传客户端（可能含内部细节）；细节只入日志，
    // 前端拿到统一的通用文案。与 run.ts catch 路径的脱敏口径保持一致。
    const msg = e instanceof Error ? e.message : String(e);
    log.error('ai.job.finalize_failed', { userId, jobId, error: msg });
    const failedJob = (await getJob(ctx.env, userId, jobId)) ?? job;
    const result: AiJobRunResult = {
      job: toApiJob(failedJob),
      done: false,
      suggested: 0,
      autoApplied: 0,
      rebalanceWarning: false,
      uncovered: 0,
      engine: 'none',
      // C-6: 通用文案，不回传原始异常消息。
      modelError: '收尾过程出现异常，建议已保存，可重试收尾',
    };
    return json(result);
  }

  const finalJob = (await getJob(ctx.env, userId, jobId)) ?? job;
  const result: AiJobRunResult = {
    job: toApiJob({ ...finalJob, status: 'done' }),
    done: true,
    suggested: 0,
    autoApplied,
    rebalanceWarning,
    uncovered: 0,
    engine: 'none',
    modelError,
    autoGrouped,
  };
  return json(result);
};

import type { Env } from '../env';
import type { AiJobEstimate } from '../../../shared/types';
import { BATCH_SIZE, buildCategorizePrompt, buildCoarsePrompt, buildRenamePrompt, buildTaggingPrompt } from './prompt';
import { MAX_OUTPUT_TOKENS, RETRY_MAX_ATTEMPTS } from './providers';
import { isModelReady, loadConfigRow, loadVocabulary } from './config';
import { MAX_JOB_ITEMS, RUN_CHUNK_LEGACY, loadBookmarkInputs, resolveCategorizeScope, resolveScope } from './store';
import type { JobScope } from './store';

/**
 * Cost forecast for a batch run, computed BEFORE any model is called.
 *
 * ## Why this exists
 *
 * "Start organising 1,800 bookmarks" used to be a leap of faith: the user had
 * no idea how many model calls they were authorising, nor roughly what those
 * calls would consume. A forecast turns the run button into an informed
 * consent — the plan doc's A1/T2 requirement ("抽样试跑 → 展示预计 token
 * 成本 → 确认后全量").
 *
 * ## Honesty limits
 *
 * Everything here is arithmetic over constants plus ONE real prompt built
 * from a sample batch — no model is called, so the estimate itself is free.
 * Token counts are a character-based heuristic (see `tokensFromChars`), not a
 * tokenizer: different providers would give different exact numbers, and the
 * UI labels them as estimates accordingly.
 */

/**
 * Character-count → token-count heuristic.
 *
 * The prompt mixes Chinese instructions (≈1 token per 1–2 characters) with
 * ASCII URLs and JSON syntax (≈1 token per ~4 characters). Two characters per
 * token sits in the middle; applied to a batch payload that is mostly Chinese
 * it errs toward overestimating — the safe direction for a cost forecast.
 */
export function tokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 2));
}

/**
 * Builds a representative model OUTPUT for one batch, so the output side of
 * the forecast is measured the same way as the input side — by constructing
 * the real thing rather than guessing a constant.
 *
 * Deliberately worst-case-ish: every bookmark gets `maxTags` tags at full
 * length, plus a full-length summary when summarisation is on. Real responses
 * are usually shorter, so the forecast overestimates cost rather than
 * underestimating it.
 */
export function representativeOutput(
  batchSize: number,
  maxTags: number,
  wantSummary: boolean,
): string {
  const tag =
    '{"name":"这是一个代表性标签","confidence":0.85,"reason":"不超过二十四个字的理由说明","isNew":false}';
  const tags = Array.from({ length: Math.max(1, maxTags) }, () => tag).join(',');
  const item = wantSummary
    ? `{"i":1,"tags":[${tags}],"summary":"这是一句代表性的一句话摘要，用于概括该书签的核心内容。","topic":"代表性的主题短语","needsReview":false}`
    : `{"i":1,"tags":[${tags}],"topic":"代表性的主题短语","needsReview":false}`;
  const items = Array.from({ length: Math.max(1, batchSize) }, () => item).join(',');
  return `{"results":[${items}]}`;
}

/**
 * Representative model OUTPUT for one categorize batch (CategorySync). Each
 * bookmark yields exactly one single-placement object — deliberately a bit
 * longer than reality (full-length category + subcategory + reason) so the
 * forecast overestimates rather than underestimates cost.
 */
export function representativeCategorizeOutput(batchSize: number): string {
  const item =
    '{"i":1,"category":"这是一个代表性的一级分类名称","subcategory":"代表性的二级分类","confidence":0.85,"reason":"不超过二十四个字的归类理由说明","isNew":false,"needsReview":false}';
  const items = Array.from({ length: Math.max(1, batchSize) }, () => item).join(',');
  return `{"results":[${items}]}`;
}

/**
 * Representative model OUTPUT for one rename batch (structured-organise Phase
 * B). One cleaned-title object per bookmark — slightly longer than reality so
 * the forecast overestimates rather than underestimates.
 */
export function representativeRenameOutput(batchSize: number): string {
  const item =
    '{"i":1,"title":"这是一个具有代表性的清理后标题示例","reason":"不超过十六字的修改理由","unchanged":false}';
  const items = Array.from({ length: Math.max(1, batchSize) }, () => item).join(',');
  return `{"results":[${items}]}`;
}

/**
 * Assumed wall-clock seconds per model call, for the happy-path time forecast.
 * A 10-bookmark batch typically answers in 3–8s; 8s errs toward overestimating
 * the wait (the safe direction for setting expectations).
 */
const SECONDS_PER_CALL = 8;

/**
 * Forecasts one run's shape and token consumption.
 *
 * Pure computation over the resolved scope plus one measured sample prompt —
 * it never calls a model, so it is safe to fetch on every scope change.
 */
export async function estimateJob(
  env: Env,
  userId: string,
  target: JobScope['target'],
  explicitIds: string[] = [],
  kind: 'tagging' | 'categorize' | 'rename' = 'tagging',
  // B-15: categorize 轨道是否纳入已有 browser_folder 归属的书签。创建任务端点
  // 接受该参数，预估必须同口径透传，否则预估范围与真实任务范围分叉。
  includeBrowserFolder = false,
): Promise<AiJobEstimate> {
  // CategorySync: the categorize track resolves scope differently (skips
  // browser_folder placements, treats `untagged` as "no primary category").
  // Rename scans every live bookmark — `untagged` has no title semantics, so
  // it promotes to `all` (mirroring jobs/index.ts) to keep the forecast honest.
  const ids =
    kind === 'categorize'
      ? await resolveCategorizeScope(env, userId, target, explicitIds, includeBrowserFolder)
      : await resolveScope(
          env,
          userId,
          kind === 'rename' && target === 'untagged' ? 'all' : target,
          explicitIds,
        );
  const bookmarks = ids.length;
  const batches = Math.ceil(bookmarks / BATCH_SIZE);
  // C-3: `chunks` 是「旧游标(串行)模式下的 /run 往返次数」口径。方案A 的并行分片
  // 模式实际往返数为 ceil(bookmarks / PARTITION=4)，但那只影响进度条粒度、不影响
  // 成本（成本由 batches 决定），预估卡片沿用串行口径以保持历史可比性。
  const chunks = Math.ceil(bookmarks / RUN_CHUNK_LEGACY);

  const row = await loadConfigRow(env, userId);
  const modelReady = isModelReady(row);

  let estimatedInputTokens = 0;
  let estimatedOutputTokens = 0;

  if (bookmarks > 0) {
    // Measure one real batch: the fixed prompt parts (preamble, schema,
    // examples, vocabulary) dominate, so one measurement beats any per-
    // bookmark constant. The sample is capped at BATCH_SIZE — a full batch —
    // which slightly overestimates the final partial batch. Fine for a
    // forecast, and it keeps this O(1) queries instead of loading the library.
    const sampleIds = ids.slice(0, BATCH_SIZE);
    const inputs = await loadBookmarkInputs(env, userId, sampleIds);
    const vocab = await loadVocabulary(env, userId);

    if (kind === 'categorize') {
      const prompt = buildCategorizePrompt(inputs, vocab);
      estimatedInputTokens = tokensFromChars(prompt.length) * batches;
      const perBatchOutput = Math.min(
        tokensFromChars(representativeCategorizeOutput(inputs.length).length),
        MAX_OUTPUT_TOKENS,
      );
      estimatedOutputTokens = perBatchOutput * batches;
    } else if (kind === 'rename') {
      const prompt = buildRenamePrompt(inputs);
      estimatedInputTokens = tokensFromChars(prompt.length) * batches;
      const perBatchOutput = Math.min(
        tokensFromChars(representativeRenameOutput(inputs.length).length),
        MAX_OUTPUT_TOKENS,
      );
      estimatedOutputTokens = perBatchOutput * batches;
    } else {
      const prompt = buildTaggingPrompt(inputs, vocab, {
        maxTags: row.maxTags,
        wantSummary: row.autoSummarize,
      });
      estimatedInputTokens = tokensFromChars(prompt.length) * batches;

      // Two-pass adds one cheap coarse call per batch; measure its prompt too so
      // the input forecast covers it instead of silently omitting it.
      if (row.twoPass) {
        estimatedInputTokens += tokensFromChars(buildCoarsePrompt(inputs).length) * batches;
      }

      const perBatchOutput = Math.min(
        tokensFromChars(representativeOutput(inputs.length, row.maxTags, row.autoSummarize).length),
        MAX_OUTPUT_TOKENS,
      );
      estimatedOutputTokens = perBatchOutput * batches;
    }
  }

  // Happy-path call count: one model call per batch. Tagging with two-pass adds
  // one coarse call per batch; categorize and rename are always a single pass.
  // The worst case multiplies by the retry ceiling — a consistently-failing
  // provider could burn that many attempts before the engine gives up, so the
  // user should see the upper bound they are authorising.
  const callsPerBatch = kind === 'tagging' && row.twoPass ? 2 : 1;
  const estimatedCalls = batches * callsPerBatch;
  const maxModelCalls = estimatedCalls * RETRY_MAX_ATTEMPTS;
  const estimatedSeconds = estimatedCalls * SECONDS_PER_CALL;

  return {
    target,
    bookmarks,
    batches,
    chunks,
    estimatedInputTokens,
    estimatedOutputTokens,
    modelReady,
    // resolveScope caps untagged/all at MAX_JOB_ITEMS; hitting the ceiling
    // exactly means more bookmarks exist than one run can cover.
    capped: target !== 'ids' && bookmarks >= MAX_JOB_ITEMS,
    estimatedCalls,
    maxModelCalls,
    estimatedSeconds,
  };
}

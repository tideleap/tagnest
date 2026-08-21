import type { Env } from '../env';
import type { AiJobEstimate } from '../../../shared/types';
import { BATCH_SIZE, buildCoarsePrompt, buildTaggingPrompt } from './prompt';
import { MAX_OUTPUT_TOKENS, RETRY_MAX_ATTEMPTS } from './providers';
import { isModelReady, loadConfigRow, loadVocabulary } from './config';
import { MAX_JOB_ITEMS, RUN_CHUNK, loadBookmarkInputs, resolveScope } from './store';
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
): Promise<AiJobEstimate> {
  const ids = await resolveScope(env, userId, target, explicitIds);
  const bookmarks = ids.length;
  const batches = Math.ceil(bookmarks / BATCH_SIZE);
  const chunks = Math.ceil(bookmarks / RUN_CHUNK);

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

  // Happy-path call count: one tagging call per batch, plus one coarse call per
  // batch when two-pass is on. The worst case multiplies by the retry ceiling —
  // a consistently-failing provider could burn that many attempts before the
  // engine gives up, so the user should see the upper bound they are authorising.
  const callsPerBatch = row.twoPass ? 2 : 1;
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

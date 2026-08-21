import type { Env } from '../env';
import { createLogger } from '../logger';
import { loadAiConfig, loadConfigRow, loadVocabulary, toLocalConfig } from './config';
import { suggestForBookmarks } from './engine';
import { saveSuggestions } from './store';
import { loadFeedbackProfile } from './feedback';
import { makeKvTagCache } from './url-cache';
import type { EnrichInput } from './types';

/**
 * AI tagging — public surface.
 *
 * The module was a single 331-line file that did configuration, three provider
 * dialects, prompt building, parsing and persistence at once. It is now split
 * by responsibility:
 *
 *   types       shared vocabulary, no dependencies
 *   config      settings + taxonomy loading, the "can the model run?" decision
 *   taxonomy    normalisation, dedupe, duplicate-cluster detection   (pure)
 *   prompt      prompt construction + response parsing               (pure)
 *   providers   the three JSON envelopes and one fetch
 *   engine      orchestration: model-first, domain fallback for coverage
 *   store       jobs and the suggestion queue
 *
 * Most of the modules are pure functions, which is why the algorithm is
 * testable without a database, a network or a key.
 */

export * from './types';
export * from './config';
export * from './taxonomy';
export * from './scoring';
export * from './grouping';
export * from './grouping-apply';
export * from './prompt';
export * from './providers';
export * from './engine';
export * from './taxonomy-tree';
export * from './url-cache';
export * from './store';
export * from './feedback';
export * from './aliases';
export * from './api';
export * from './metrics';
export * from './estimate';

/**
 * Enriches one freshly saved bookmark. Safe to hand straight to `ctx.waitUntil`.
 *
 * Behaviour change from the original: the model no longer writes tags directly
 * into the library. Its output lands in the suggestion queue, where the user
 * confirms it — unless they have lowered the auto-apply threshold, in which
 * case high-confidence tags are applied immediately.
 *
 * That indirection is the whole point of the refactor. Direct writes meant the
 * only safe setting was "off", which is exactly where the feature sat. With a
 * review queue the model can be given far more responsibility — it now runs on
 * every save *and* every import *and* on demand across the whole library —
 * because nothing it proposes is irreversible or unattributed.
 *
 * Every failure path is swallowed and logged: a dead provider must never turn
 * into a failed save.
 */
export async function enrichBookmark(
  env: Env,
  userId: string,
  bookmarkId: string,
  input: EnrichInput,
): Promise<void> {
  const log = createLogger(env);

  try {
    const row = await loadConfigRow(env, userId);
    const local = toLocalConfig(row);
    const config = await loadAiConfig(env, userId);

    // When no model is configured the caller (a job run) still gets
    // domain-derived fallback tags from suggestForBookmarks. On the silent
    // save path we skip enrichment entirely — key-less users have explicitly
    // accepted losing automatic organisation (they can run a job for fallback
    // tags). Model-backed saves always proceed.
    if (!config) return;

    const vocab = await loadVocabulary(env, userId);
    const feedback = await loadFeedbackProfile(env, userId);
    const outcome = await suggestForBookmarks([{ id: bookmarkId, ...input }], {
      vocab,
      config,
      local,
      feedback,
      tagCache: env.AI_CACHE ? makeKvTagCache(env.AI_CACHE) : undefined,
    });

    const result = outcome.results[0];
    if (!result || (result.tags.length === 0 && !result.summary)) {
      log.info('ai.enrich.empty', { userId, engine: outcome.engine });
      return;
    }

    await saveSuggestions(env, userId, null, [result]);

    log.info('ai.enrich', {
      userId,
      engine: outcome.engine,
      suggested: result.tags.length,
      summarized: Boolean(result.summary),
    });
  } catch (error) {
    log.warn('ai.enrich.failed', {
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

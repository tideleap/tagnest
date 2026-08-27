import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, readJson } from '../../../_lib/http';
import {
  applyAliases,
  buildAliasSuggestions,
  generateModelAliases,
  loadAliasSuggestions,
  loadTopicClusters,
  type ApplyAliasItem,
} from '../../../_lib/ai';
import { getEffectiveAiConfig, consumeAiCredit, loadVocabulary } from '../../../_lib/ai';

/**
 * Automatic alias expansion + topic clustering for the taxonomy health page.
 *
 * `GET`  → offline alias proposals + the pending-suggestion topic distribution.
 *          Always works, no model call, instant.
 * `POST` → two actions, chosen by `body.action`:
 *   - `apply`    : persist confirmed aliases into `tags.aliases` (JSON array),
 *                  where the normaliser already folds them in on every proposal.
 *   - `generate` : ask the model for richer aliases; when no model is
 *                  configured it falls back to the offline proposals so the UI
 *                  never shows an empty state.
 *
 * Read-only by default and additive only — applying an alias never deletes a
 * tag or rewrites bookmark links, which keeps this squarely in the "safe,
 * reversible maintenance" half of the feature.
 */

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const [aliasSuggestions, topicClusters] = await Promise.all([
    loadAliasSuggestions(ctx.env, userId),
    loadTopicClusters(ctx.env, userId),
  ]);
  return json({ aliasSuggestions, topicClusters });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ action?: string; apply?: ApplyAliasItem[]; tagIds?: string[] }>(ctx.request);
  const action = body.action;

  if (action === 'apply') {
    const items = Array.isArray(body.apply) ? body.apply : [];
    const { updated } = await applyAliases(ctx.env, userId, items);
    return json({ updated });
  }

  if (action === 'generate') {
    const effective = await getEffectiveAiConfig(ctx.env, userId);
    const config = effective?.config ?? null;
    const vocab = await loadVocabulary(ctx.env, userId);
    const requested = new Set(Array.isArray(body.tagIds) ? body.tagIds : []);
    const entries = vocab.entries.filter((e) => requested.size === 0 || requested.has(e.id));

    // No model available (or it failed): return the offline proposals rather
    // than an error, so the UI can still offer something actionable.
    if (!config) {
      return json({
        aliasSuggestions: buildAliasSuggestions(entries),
        topicClusters: await loadTopicClusters(ctx.env, userId),
        modelAvailable: false,
      });
    }

    const generated = await generateModelAliases(
      config,
      entries.map((e) => e.name),
      fetch,
    );
    const byName = new Map(vocab.entries.map((e) => [e.name, e.id]));
    const aliasSuggestions = generated
      .map((s) => ({ ...s, tagId: byName.get(s.tagName) ?? s.tagId }))
      .filter((s) => s.tagId);

    // Meter the hosted tier for this maintenance call; best-effort.
    if (effective?.managed) {
      try {
        await consumeAiCredit(ctx.env, userId, entries.length, 'ai.aliases');
      } catch {
        /* meter is best-effort */
      }
    }

    return json({ aliasSuggestions, modelAvailable: true });
  }

  throw badRequest('action 必须为 apply 或 generate');
};

import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, badRequestCode, json, readJson } from '../../_lib/http';
import {
  classifyTag,
  listPendingSuggestions,
  getEffectiveAiConfig,
  consumeAiCredit,
  loadBookmarkInputs,
  loadConfigRow,
  loadFeedbackProfile,
  loadFewShotExamples,
  loadVocabulary,
  makeKvTagCache,
  saveSuggestions,
  suggestForBookmarks,
  toApiSuggestion,
  toLocalConfig,
} from '../../_lib/ai';

/** Small enough to finish inside one request; larger sets belong in a job. */
const MAX_INLINE = 20;

/**
 * Analyses a handful of bookmarks synchronously and returns fresh proposals.
 *
 * The immediate path, for "re-analyse this bookmark" on a detail page or after
 * editing a title. Anything bigger goes through `POST /api/ai/jobs`, which
 * chunks and reports progress.
 *
 * Note this *replaces* pending proposals for those bookmarks rather than
 * adding to them (see `saveSuggestions`): re-running should refresh the
 * answer, not stack a second copy of it.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ bookmarkIds?: unknown; synthesizeTree?: unknown }>(ctx.request);

  const requested = Array.isArray(body.bookmarkIds)
    ? [...new Set(body.bookmarkIds.map(String))].filter(Boolean).slice(0, MAX_INLINE)
    : [];
  if (requested.length === 0) throw badRequest('请选择要分析的书签');

  const row = await loadConfigRow(ctx.env, userId);
  const local = toLocalConfig(row);
  // A-4（第二轮审计）: 复用已读取的配置行，避免 getEffectiveAiConfig 内部二次
  // 读 ai_settings + 二次解密（保存热路径每次省一次读库+解密）。
  const effective = await getEffectiveAiConfig(ctx.env, userId, row);
  const config = effective?.config ?? null;

  // With the local rule engine removed, a missing model is the only thing that
  // blocks an explicit re-analyse; a job run still falls back to domain tags.
  if (!config) {
    throw badRequestCode(
      'ai_no_engine',
      '未配置可用的模型，无法生成标签建议',
    );
  }

  const inputs = await loadBookmarkInputs(ctx.env, userId, requested);
  if (inputs.length === 0) throw badRequest('所选书签不存在或已被删除');

  const vocab = await loadVocabulary(ctx.env, userId);
  const feedback = await loadFeedbackProfile(ctx.env, userId);
  // 方案B: teach the model the user's own tagging style via their well-tagged
  // bookmarks instead of a canned example set.
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
    synthesizeTree: body.synthesizeTree === true,
    tagCache: ctx.env.AI_CACHE ? makeKvTagCache(ctx.env.AI_CACHE) : undefined,
  });

  await saveSuggestions(ctx.env, userId, null, outcome.results);

  // Meter the hosted tier. Only real model calls spend credits; a fallback run
  // is free. Best-effort: a ledger hiccup must never fail the user's analysis.
  // B-12（第二轮审计）: 扣除隔离的成人内容书签（从未送模型、不耗 token）。
  if (effective?.managed && outcome.engine === 'model') {
    try {
      const analysed = Math.max(0, inputs.length - (outcome.adultQuarantined ?? 0));
      await consumeAiCredit(ctx.env, userId, analysed, 'ai.suggest');
    } catch {
      /* meter is best-effort */
    }
  }

  // Read back rather than echoing the in-memory result: the store drops tags
  // the bookmark already has and ones the user previously rejected, so this is
  // the only view that matches what the review queue will actually show.
  const all = await listPendingSuggestions(ctx.env, userId, 200);
  const wanted = new Set(inputs.map((i) => i.id));
  const suggestions = all
    .filter((s) => wanted.has(s.bookmarkId))
    .map((s) => {
      const path = classifyTag(s.tagName);
      return { ...toApiSuggestion(s), category: path?.[0] ?? null, subcategory: path?.[1] ?? null };
    });

  return json({
    suggestions,
    engine: outcome.engine,
    modelError: outcome.modelError,
    analyzed: inputs.length,
  });
};

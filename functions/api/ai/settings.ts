import type { AiProvider, AiSettings } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';

/**
 * AI configuration storage.
 *
 * The feature is intentionally inert: these values are written and read back,
 * and nothing in the codebase sends a request to a provider. Wiring the
 * settings up first means the eventual model integration is a handler change
 * rather than a schema migration and a UI rewrite.
 */

const PROVIDERS: AiProvider[] = ['none', 'openai', 'anthropic', 'gemini', 'custom'];

const DEFAULTS: AiSettings = {
  provider: 'none',
  baseUrl: null,
  model: null,
  hasApiKey: false,
  autoSummarize: false,
  autoTag: false,
  enabled: false,
};

function mapSettings(row: Record<string, unknown> | null): AiSettings {
  if (!row) return DEFAULTS;
  return {
    provider: (row.provider as AiProvider) ?? 'none',
    baseUrl: (row.base_url as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    // The key itself never leaves the database.
    hasApiKey: Boolean(row.api_key_encrypted),
    autoSummarize: row.auto_summarize === 1,
    autoTag: row.auto_tag === 1,
    enabled: row.enabled === 1,
  };
}

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const row = await ctx.env.DB.prepare(`SELECT * FROM ai_settings WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>();
  return json(mapSettings(row));
};

export const onRequestPut: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  const current = await ctx.env.DB.prepare(`SELECT * FROM ai_settings WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>();

  const merged = mapSettings(current);

  if ('provider' in body) {
    const provider = String(body.provider) as AiProvider;
    if (!PROVIDERS.includes(provider)) throw badRequest('不支持的服务商');
    merged.provider = provider;
  }
  if ('baseUrl' in body) {
    merged.baseUrl = body.baseUrl ? String(body.baseUrl).trim().slice(0, 300) : null;
  }
  if ('model' in body) {
    merged.model = body.model ? String(body.model).trim().slice(0, 120) : null;
  }
  if ('autoSummarize' in body) merged.autoSummarize = Boolean(body.autoSummarize);
  if ('autoTag' in body) merged.autoTag = Boolean(body.autoTag);
  if ('enabled' in body) merged.enabled = Boolean(body.enabled);

  // An empty string clears the key; omitting the field leaves it in place, so
  // saving other settings does not silently wipe the credential.
  let apiKey: string | null | undefined;
  if ('apiKey' in body) {
    const raw = body.apiKey === null ? '' : String(body.apiKey).trim();
    apiKey = raw ? raw.slice(0, 500) : null;
  }

  const ts = nowIso();

  if (current) {
    const sets = [
      'provider = ?',
      'base_url = ?',
      'model = ?',
      'auto_summarize = ?',
      'auto_tag = ?',
      'enabled = ?',
      'updated_at = ?',
    ];
    const params: unknown[] = [
      merged.provider,
      merged.baseUrl,
      merged.model,
      merged.autoSummarize ? 1 : 0,
      merged.autoTag ? 1 : 0,
      merged.enabled ? 1 : 0,
      ts,
    ];
    if (apiKey !== undefined) {
      sets.push('api_key_encrypted = ?');
      params.push(apiKey);
      merged.hasApiKey = Boolean(apiKey);
    }
    params.push(userId);
    await ctx.env.DB.prepare(`UPDATE ai_settings SET ${sets.join(', ')} WHERE user_id = ?`)
      .bind(...params)
      .run();
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO ai_settings
         (user_id, provider, base_url, model, api_key_encrypted,
          auto_summarize, auto_tag, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        userId,
        merged.provider,
        merged.baseUrl,
        merged.model,
        apiKey ?? null,
        merged.autoSummarize ? 1 : 0,
        merged.autoTag ? 1 : 0,
        merged.enabled ? 1 : 0,
        ts,
      )
      .run();
    merged.hasApiKey = Boolean(apiKey);
  }

  return json(merged);
};

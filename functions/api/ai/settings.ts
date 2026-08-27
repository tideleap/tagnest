import type { AiProvider, AiSettings } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { encryptField } from '../../_lib/crypto';

/**
 * AI configuration storage.
 *
 * ## The `enabled` trap this handler used to set
 *
 * `enabled` was stored as an independent boolean and the backend gated all
 * inference on it — but nothing ever set it to 1. The column defaulted to 0,
 * registration hard-coded 0, and the settings UI had no such switch. Users
 * could fill in a provider, a model and a key, see a green "AI 已就绪" banner,
 * and get nothing. Forever.
 *
 * It is now **derived** on write from the fields that actually determine
 * whether a call can be made, and no read path gates on the column any more
 * (see `_lib/ai/config.ts#isModelReady`). The column is still written so the
 * UI and any reporting can read the resolved state, but it can no longer
 * disagree with reality. Pausing is explicit: set the provider to 未选择, or
 * turn off both automation toggles.
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
  autoApplyThreshold: 1,
  maxTags: 4,
  fetchContent: true,
  twoPass: false,
  // Migration 0025 default: a hosted account is meant to be zero-config.
  managedEnabled: true,
};

/**
 * Mirrors `_lib/ai/config.ts#isModelReady`.
 *
 * Kept as a local expression over the DTO rather than importing the row-level
 * predicate, because here the only fact available about the key is whether one
 * exists — the plaintext is never loaded on this path.
 */
function deriveEnabled(s: AiSettings): boolean {
  if (s.provider === 'none') return false;
  if (!s.model || !s.model.trim()) return false;
  if (!s.hasApiKey) return false;
  if (!s.autoTag && !s.autoSummarize) return false;
  return true;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function mapSettings(row: Record<string, unknown> | null): AiSettings {
  if (!row) return { ...DEFAULTS };

  const settings: AiSettings = {
    provider: (row.provider as AiProvider) ?? 'none',
    baseUrl: (row.base_url as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    // The key itself never leaves the database.
    hasApiKey: Boolean(row.api_key_encrypted),
    autoSummarize: row.auto_summarize === 1,
    autoTag: row.auto_tag === 1,
    enabled: false,
    autoApplyThreshold: clamp(row.auto_apply_threshold, 0, 1, 1),
    maxTags: Math.trunc(clamp(row.max_tags, 1, 8, 4)),
    // `!== 0` mirrors the migration default (fetching on); a missing column
    // on a pre-migration row still reads as enabled.
    fetchContent: row.fetch_content !== 0,
    twoPass: row.two_pass === 1,
    // `!== 0` mirrors fetchContent: a missing managed_enabled column (or a
    // pre-0025 row) reads as the migration default — consent on.
    managedEnabled: row.managed_enabled !== 0,
  };

  // Always recomputed on read, so a stale column value can never mislead.
  settings.enabled = deriveEnabled(settings);
  return settings;
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
  if ('autoApplyThreshold' in body) {
    merged.autoApplyThreshold = clamp(body.autoApplyThreshold, 0, 1, 1);
  }
  if ('maxTags' in body) merged.maxTags = Math.trunc(clamp(body.maxTags, 1, 8, 4));
  if ('fetchContent' in body) merged.fetchContent = Boolean(body.fetchContent);
  if ('twoPass' in body) merged.twoPass = Boolean(body.twoPass);
  if ('managedEnabled' in body) merged.managedEnabled = Boolean(body.managedEnabled);
  // User consent for hosted inference. Default-on in DEFAULTS, so a settings
  // write that omits it keeps the last value rather than flipping consent off.
  if ('managedEnabled' in body) merged.managedEnabled = Boolean(body.managedEnabled);

  // `enabled` is deliberately NOT read from the body. It is a status, not a
  // setting; accepting it would reintroduce the drift this handler documents.

  // An empty string clears the key; omitting the field leaves it in place, so
  // saving other settings does not silently wipe the credential.
  //
  // The value is sealed with AES-256-GCM before it touches the database, so a
  // D1 export is not a list of live provider credentials.
  let apiKey: string | null | undefined;
  if ('apiKey' in body) {
    const raw = body.apiKey === null ? '' : String(body.apiKey).trim();
    apiKey = raw ? await encryptField(raw.slice(0, 500), ctx.env) : null;
    merged.hasApiKey = Boolean(apiKey);
  }

  // Recompute after every field has settled, including a key just supplied or
  // cleared in this same request.
  merged.enabled = deriveEnabled(merged);

  const ts = nowIso();

  if (current) {
    const sets = [
      'provider = ?',
      'base_url = ?',
      'model = ?',
      'auto_summarize = ?',
      'auto_tag = ?',
      'enabled = ?',
      'auto_apply_threshold = ?',
      'max_tags = ?',
      'fetch_content = ?',
      'two_pass = ?',
      'managed_enabled = ?',
      'updated_at = ?',
    ];
    const params: unknown[] = [
      merged.provider,
      merged.baseUrl,
      merged.model,
      merged.autoSummarize ? 1 : 0,
      merged.autoTag ? 1 : 0,
      merged.enabled ? 1 : 0,
      merged.autoApplyThreshold,
      merged.maxTags,
      merged.fetchContent ? 1 : 0,
      merged.twoPass ? 1 : 0,
      merged.managedEnabled ? 1 : 0,
      ts,
    ];
    if (apiKey !== undefined) {
      sets.push('api_key_encrypted = ?');
      params.push(apiKey);
    }
    params.push(userId);
    await ctx.env.DB.prepare(`UPDATE ai_settings SET ${sets.join(', ')} WHERE user_id = ?`)
      .bind(...params)
      .run();
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO ai_settings
         (user_id, provider, base_url, model, api_key_encrypted,
          auto_summarize, auto_tag, enabled,
          auto_apply_threshold, max_tags, fetch_content, two_pass, managed_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        merged.autoApplyThreshold,
        merged.maxTags,
        merged.fetchContent ? 1 : 0,
        merged.twoPass ? 1 : 0,
        merged.managedEnabled ? 1 : 0,
        ts,
      )
      .run();
  }

  return json(merged);
};

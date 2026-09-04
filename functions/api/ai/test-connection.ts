import type { AiProbeResult, AiProvider } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import { isBlockedHost } from '../../_lib/ssrf';
import { parseUrl } from '../../_lib/urlkey';
import { decryptField } from '../../_lib/crypto';
import {
  buildMinimalInferenceRequest,
  buildModelsRequest,
  parseModelsPayload,
  resolveProbeEndpoint,
} from '../../_lib/ai/probe';
import type { ProbeRequest } from '../../_lib/ai/probe';

/**
 * POST /api/ai/test-connection — verifies a user-supplied AI endpoint before
 * (or after) it is saved, and discovers the models it offers.
 *
 * Contract:
 *  - Every field is optional; anything omitted falls back to the stored
 *    settings, so "test what I have" and "test what I'm about to save" are
 *    one endpoint. The stored key is decrypted server-side and never returned.
 *  - Provider-side failures come back as `200 { ok: false, message }` so the
 *    UI can render the reason without parsing HTTP errors. Only malformed
 *    input throws 400.
 *  - SSRF: the literal host is checked against the blocklist, and redirects
 *    are followed manually with every hop re-validated (same discipline as
 *    `api/metadata.ts`).
 *  - Rate limited per user via KV (soft counter, degrades open when the
 *    binding is absent) so a stuck gateway cannot be hammered through us.
 */

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'gemini', 'custom'];
const PROBE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const RATE_LIMIT_PER_MINUTE = 10;

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  await assertProbeBudget(ctx.env, userId);

  // ---- Resolve the effective configuration (body wins, stored fills gaps) ----
  const stored = await ctx.env.DB.prepare(`SELECT * FROM ai_settings WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>();

  const provider = (
    'provider' in body ? String(body.provider) : ((stored?.provider as string) ?? 'none')
  ) as AiProvider;
  if (!PROVIDERS.includes(provider)) {
    throw badRequest('请先选择服务商');
  }

  const baseUrl =
    'baseUrl' in body
      ? body.baseUrl
        ? String(body.baseUrl).trim().slice(0, 300)
        : null
      : ((stored?.base_url as string | null) ?? null);

  const model =
    'model' in body
      ? body.model
        ? String(body.model).trim().slice(0, 120)
        : null
      : ((stored?.model as string | null) ?? null);

  let apiKey: string | null;
  if ('apiKey' in body) {
    const raw = body.apiKey === null ? '' : String(body.apiKey).trim();
    apiKey = raw ? raw.slice(0, 500) : null;
  } else {
    apiKey = await decryptField((stored?.api_key_encrypted as string | null) ?? null, ctx.env);
  }
  if (!apiKey) throw badRequest('请填写 API Key 后再测试连接');

  // ---- SSRF gate on the literal host ----
  const endpoint = resolveProbeEndpoint(provider, baseUrl);
  if (!endpoint) throw badRequest('请填写接口地址');
  const parsed = parseUrl(endpoint);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw badRequest('接口地址必须是 http/https URL');
  }
  if (isBlockedHost(parsed.hostname)) throw badRequest('接口地址不被允许');

  const checkedUrl = endpoint;

  // ---- Probe 1: the provider's model list ----
  const listReq = buildModelsRequest(provider, baseUrl, apiKey);
  const listRes = listReq ? await safeFetch(listReq) : null;

  if (listRes && listRes.status >= 200 && listRes.status < 300) {
    const payload = (await listRes.json().catch(() => null)) as unknown;
    const models = parseModelsPayload(provider, payload);
    return json<AiProbeResult>({
      ok: true,
      message: models.length > 0 ? `连接成功，发现 ${models.length} 个可用模型` : '连接成功',
      models,
      checkedUrl,
    });
  }

  // ---- Probe 2: list endpoint missing → prove the key with one tiny call ----
  const listMissing = listRes !== null && (listRes.status === 404 || listRes.status === 405);
  if (listMissing && model) {
    const inferReq = buildMinimalInferenceRequest(provider, baseUrl, apiKey, model);
    const inferRes = inferReq ? await safeFetch(inferReq) : null;
    if (inferRes && inferRes.status >= 200 && inferRes.status < 300) {
      return json<AiProbeResult>({
        ok: true,
        message: '连接成功（该端点不提供模型列表，请手动填写模型名称）',
        models: [],
        checkedUrl,
        modelsUnavailable: true,
      });
    }
    // The inference call has a more specific verdict — fall through with it.
    if (inferRes) {
      return json<AiProbeResult>({
        ok: false,
        message: describeStatus(inferRes.status, await peekError(inferRes)),
        models: [],
        checkedUrl,
      });
    }
  }

  if (!listRes) {
    return json<AiProbeResult>({
      ok: false,
      message: '无法连接到该地址（网络不可达或超时）',
      models: [],
      checkedUrl,
    });
  }

  return json<AiProbeResult>({
    ok: false,
    message: describeStatus(listRes.status, await peekError(listRes)),
    models: [],
    checkedUrl,
  });
};

/** Credential-bearing headers that must never leave the original origin. */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key'];

/** Follows redirects manually, re-validating every hop against the blocklist. */
async function safeFetch(req: ProbeRequest): Promise<Response | null> {
  let current = req.url;
  // C-5（第二轮审计）: 跨 origin 重定向时剥离凭据头，与 providers.ts 的
  // ssrfSafeFetch 同一防线——用户端点 302 到任意主机不得带走密钥。
  const originOf = (u: string): string => {
    try {
      return new URL(u).origin;
    } catch {
      return '';
    }
  };
  const initialOrigin = originOf(req.url);
  let headers: Record<string, string> = { ...req.headers };
  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  };

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const res = await fetch(current, init);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('Location');
        if (!loc) return res;
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          return null;
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
        if (isBlockedHost(next.hostname)) return null;
        // Strip credentials when the redirect leaves the original origin.
        if (next.origin !== initialOrigin) {
          const stripped: Record<string, string> = {};
          for (const [k, v] of Object.entries(headers)) {
            if (!CREDENTIAL_HEADERS.includes(k.toLowerCase())) stripped[k] = v;
          }
          headers = stripped;
          init.headers = headers;
        }
        current = next.toString();
        await res.arrayBuffer().catch(() => null);
        continue;
      }
      return res;
    }
    return null;
  } catch {
    return null; // timeout / network — reported as unreachable
  }
}

/** Reads a short error snippet without consuming the response twice. */
async function peekError(res: Response): Promise<string> {
  try {
    const text = await res.clone().text();
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

function describeStatus(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'API Key 无效或无权限';
  if (status === 404) return '模型或接口地址不存在';
  if (status === 429) return '触发服务商限流，请稍后再试';
  if (status >= 500) return '服务商暂时不可用';
  return `服务商返回 ${status}${detail ? `：${detail}` : ''}`;
}

/**
 * Soft per-user budget: at most RATE_LIMIT_PER_MINUTE probes per rolling
 * minute. KV get/put is not atomic, so a burst may slip one or two through —
 * acceptable for a brake, not a vault. Degrades open when AI_CACHE is absent
 * (local dev / tests), matching the project's "endpoint stays up" convention.
 */
async function assertProbeBudget(env: Env, userId: string): Promise<void> {
  const kv = env.AI_CACHE;
  if (!kv) return;
  const key = `aiprobe:${userId}`;
  try {
    const raw = await kv.get(key);
    const count = raw ? Number(raw) : 0;
    if (Number.isFinite(count) && count >= RATE_LIMIT_PER_MINUTE) {
      throw badRequest('测试过于频繁，请稍后再试');
    }
    await kv.put(key, String((Number.isFinite(count) ? count : 0) + 1), { expirationTtl: 60 });
  } catch (e) {
    if (e instanceof Error && e.message === '测试过于频繁，请稍后再试') throw e;
    console.warn('[tagnest] probe budget check unavailable', e);
  }
}

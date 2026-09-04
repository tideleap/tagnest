// tests/ai-probe.test.ts
//
// Connection probing: pure request/response plumbing (probe.ts) plus the
// POST /api/ai/test-connection endpoint contract against the in-memory D1
// mock. All provider traffic goes through a stubbed global fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestPost as testConnection } from '../functions/api/ai/test-connection';
import {
  buildMinimalInferenceRequest,
  buildModelsRequest,
  parseModelsPayload,
  resolveProbeEndpoint,
  MAX_MODELS_RETURNED,
} from '../functions/_lib/ai/probe';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';

function jsonCtx(env: Env, body?: unknown) {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request('https://tagnest.test/api/ai/test-connection', init),
    env,
    data: { userId: USER },
    params: {},
  } as any;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Pure plumbing
// ---------------------------------------------------------------------------

describe('resolveProbeEndpoint', () => {
  it('requires an explicit base for custom providers', () => {
    expect(resolveProbeEndpoint('custom', null)).toBeNull();
    expect(resolveProbeEndpoint('custom', 'https://gw.example.com/v1/')).toBe(
      'https://gw.example.com/v1',
    );
  });

  it('falls back to the provider default endpoint', () => {
    expect(resolveProbeEndpoint('openai', null)).toBe('https://api.openai.com/v1');
    expect(resolveProbeEndpoint('none', 'https://x.example.com')).toBeNull();
  });
});

describe('buildModelsRequest', () => {
  it('uses Bearer auth for openai-compatible endpoints', () => {
    const req = buildModelsRequest('custom', 'https://gw.example.com/v1', 'sk-test');
    expect(req).toMatchObject({
      method: 'GET',
      url: 'https://gw.example.com/v1/models',
      headers: { authorization: 'Bearer sk-test' },
    });
  });

  it('uses x-api-key for anthropic', () => {
    const req = buildModelsRequest('anthropic', null, 'sk-ant');
    expect(req?.url).toBe('https://api.anthropic.com/v1/models');
    expect(req?.headers['x-api-key']).toBe('sk-ant');
  });

  it('puts the gemini key in the x-goog-api-key header, not the query string', () => {
    const req = buildModelsRequest('gemini', null, 'gm-key');
    // C-5: the key must not ride in the URL (it leaks into logs / referers).
    expect(req?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(req?.headers['x-goog-api-key']).toBe('gm-key');
  });
});

describe('buildMinimalInferenceRequest', () => {
  it('builds a one-token chat completion for openai-compatible', () => {
    const req = buildMinimalInferenceRequest('custom', 'https://gw.example.com/v1', 'sk', 'qwen-flash');
    expect(req?.url).toBe('https://gw.example.com/v1/chat/completions');
    expect((req?.body as any).max_tokens).toBe(1);
    expect((req?.body as any).model).toBe('qwen-flash');
  });

  it('refuses without a model name', () => {
    expect(buildMinimalInferenceRequest('openai', null, 'sk', '  ')).toBeNull();
  });
});

describe('parseModelsPayload', () => {
  it('extracts openai-shaped ids', () => {
    expect(parseModelsPayload('openai', { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
  });

  it('strips the gemini models/ prefix', () => {
    expect(
      parseModelsPayload('gemini', { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/a' }] }),
    ).toEqual(['a', 'gemini-2.0-flash']);
  });

  it('dedupes, sorts and caps the list', () => {
    const data = Array.from({ length: MAX_MODELS_RETURNED + 50 }, (_, i) => ({
      id: `m-${String(i).padStart(4, '0')}`,
    }));
    data.push({ id: 'm-0000' }); // duplicate
    const out = parseModelsPayload('custom', { data });
    expect(out).toHaveLength(MAX_MODELS_RETURNED);
    expect(out[0]).toBe('m-0000');
    expect(new Set(out).size).toBe(out.length);
  });

  it('returns [] for unrecognised shapes', () => {
    expect(parseModelsPayload('openai', { weird: true })).toEqual([]);
    expect(parseModelsPayload('openai', null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Endpoint contract
// ---------------------------------------------------------------------------

let env: Env;
let db: MockDb;

beforeEach(() => {
  env = makeEnv();
  db = env.DB as MockDb;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/ai/test-connection', () => {
  it('reports success with the discovered models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ id: 'qwen-flash' }, { id: 'deepseek-v3' }] })),
    );
    const res = await testConnection(
      jsonCtx(env, { provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-test' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(['deepseek-v3', 'qwen-flash']);
    expect(body.checkedUrl).toBe('https://gw.example.com/v1');
  });

  it('reports an invalid key as ok:false inside a 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad token' }, 401)));
    const res = await testConnection(
      jsonCtx(env, { provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-bad' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toBe('API Key 无效或无权限');
    expect(body.models).toEqual([]);
  });

  it('falls back to a minimal inference probe when /models is missing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) return jsonResponse({ error: 'not found' }, 404);
      return jsonResponse({ choices: [{ message: { content: 'pong' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await testConnection(
      jsonCtx(env, {
        provider: 'custom',
        baseUrl: 'https://gw.example.com/v1',
        apiKey: 'sk-test',
        model: 'qwen-flash',
      }),
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.modelsUnavailable).toBe(true);
    expect(body.models).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses the gemini catalogue shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ models: [{ name: 'models/gemini-2.0-flash' }] })),
    );
    const res = await testConnection(jsonCtx(env, { provider: 'gemini', apiKey: 'gm-key' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(['gemini-2.0-flash']);
  });

  it('falls back to the stored key when the body omits it', async () => {
    db.ai_settings.push({
      user_id: USER,
      provider: 'custom',
      base_url: 'https://stored.example.com/v1',
      model: 'stored-model',
      // Legacy plaintext: decryptField passes it through unchanged.
      api_key_encrypted: 'sk-stored',
    } as any);
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'stored-model' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await testConnection(jsonCtx(env, {}));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checkedUrl).toBe('https://stored.example.com/v1');
    // The stored key reached the provider.
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer sk-stored');
  });

  it('rejects SSRF targets with 400', async () => {
    await expect(
      testConnection(
        jsonCtx(env, { provider: 'custom', baseUrl: 'http://127.0.0.1/v1', apiKey: 'sk-test' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      testConnection(
        jsonCtx(env, { provider: 'custom', baseUrl: 'http://localhost:11434/v1', apiKey: 'sk' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a redirect hop into a blocked host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest' } }),
      ),
    );
    const res = await testConnection(
      jsonCtx(env, { provider: 'custom', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-test' }),
    );
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain('无法连接');
  });

  it('requires a provider', async () => {
    await expect(testConnection(jsonCtx(env, { apiKey: 'sk' }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('requires a key (body or stored)', async () => {
    await expect(
      testConnection(jsonCtx(env, { provider: 'openai', baseUrl: 'https://api.openai.com/v1' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('throttles repeated probes per user', async () => {
    env = makeEnv({
      AI_CACHE: {
        get: async () => '10',
        put: async () => undefined,
      },
    });
    await expect(
      testConnection(jsonCtx(env, { provider: 'openai', apiKey: 'sk' })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

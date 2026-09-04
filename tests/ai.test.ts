import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RESPONSE_BYTES,
  MAX_SUMMARY_LENGTH,
  MAX_TAG_LENGTH,
  buildProviderRequest,
  buildTaggingPrompt,
  callProvider,
  extractText,
  parseTaggingResponse,
  buildVocabulary,
  type AiConfig,
} from '../functions/_lib/ai';

const base: AiConfig = {
  provider: 'openai',
  baseUrl: null,
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  autoTag: true,
  autoSummarize: true,
  autoApplyThreshold: 1,
  maxTags: 4,
};

describe('provider request shaping', () => {
  it('uses the OpenAI chat envelope with a bearer token', () => {
    const req = buildProviderRequest(base, 'hello')!;
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect((req.body as { model: string }).model).toBe('gpt-4o-mini');
  });

  it('sends Anthropic its own header set and version pin', () => {
    const req = buildProviderRequest({ ...base, provider: 'anthropic' }, 'hello')!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-test');
    expect(req.headers['anthropic-version']).toBeTruthy();
    expect(req.headers.authorization).toBeUndefined();
  });

  it('puts the Gemini key in the x-goog-api-key header, not the query string', () => {
    const req = buildProviderRequest({ ...base, provider: 'gemini', model: 'gemini-1.5' }, 'hi')!;
    expect(req.url).toContain('/models/gemini-1.5:generateContent');
    // C-5: the key must not ride in the URL (it leaks into logs / referers).
    expect(req.url).not.toContain('key=');
    expect(req.headers['x-goog-api-key']).toBe('sk-test');
  });

  it('routes a custom provider through the OpenAI shape at its own base URL', () => {
    const req = buildProviderRequest(
      { ...base, provider: 'custom', baseUrl: 'http://127.0.0.1:1234/v1/' },
      'hi',
    )!;
    expect(req.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('refuses a custom provider with no base URL rather than guessing', () => {
    expect(buildProviderRequest({ ...base, provider: 'custom', baseUrl: null }, 'hi')).toBeNull();
    expect(buildProviderRequest({ ...base, provider: 'none' }, 'hi')).toBeNull();
  });

  it('lets extraBody add tuning knobs but strips stream/messages/model (D-5)', () => {
    const req = buildProviderRequest(
      {
        ...base,
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1234/v1',
        extraBody: {
          enable_thinking: false,
          stream: true,
          messages: [{ role: 'system', content: 'injected' }],
          model: 'evil-model',
        },
      },
      'hi',
    )!;
    const body = req.body as Record<string, unknown>;
    // Legitimate tuning knobs pass through.
    expect(body.enable_thinking).toBe(false);
    // `stream` has no fixed field after the spread — it must be stripped,
    // otherwise the gateway switches to SSE and JSON parsing fails.
    expect(body.stream).toBeUndefined();
    // Identity fields stay pinned to the request's own values.
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('response extraction', () => {
  it('reads each provider envelope', () => {
    expect(extractText('openai', { choices: [{ message: { content: 'a' } }] })).toBe('a');
    expect(extractText('anthropic', { content: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(extractText('gemini', { candidates: [{ content: { parts: [{ text: 'g' }] } }] })).toBe('g');
  });

  it('returns null for a malformed envelope rather than throwing', () => {
    expect(extractText('openai', null)).toBeNull();
    expect(extractText('openai', {})).toBeNull();
    expect(extractText('gemini', { candidates: [] })).toBeNull();
  });
});

describe('buildTaggingPrompt — classification against the user taxonomy', () => {
  const vocab = buildVocabulary([
    { id: 't1', name: '前端', aliases: [], count: 40 },
    { id: 't2', name: '后端', aliases: [], count: 12 },
  ]);

  it('tells the model to reuse existing tags when it has a taxonomy', () => {
    const prompt = buildTaggingPrompt([{ url: 'https://a.dev', title: 'A' }], vocab, {
      maxTags: 4,
      wantSummary: false,
    });
    expect(prompt).toContain('已有标签');
    expect(prompt).toContain('前端');
  });

  it('asks for a summary only when summarisation is switched on', () => {
    const off = buildTaggingPrompt([{ url: 'https://a.dev', title: 'A' }], vocab, {
      maxTags: 4,
      wantSummary: false,
    });
    const on = buildTaggingPrompt([{ url: 'https://a.dev', title: 'A' }], vocab, {
      maxTags: 4,
      wantSummary: true,
    });
    expect(off.toLowerCase()).not.toContain('summary');
    expect(on).toContain('summary');
  });

  it('caps a long description instead of sending the whole page', () => {
    const prompt = buildTaggingPrompt(
      [{ url: 'https://a.dev', title: 'A', description: 'x'.repeat(5000) }],
      vocab,
      { maxTags: 4, wantSummary: false },
    );
    // Description is truncated to 400 chars. Bound is generous enough for the
    // fixed preamble + vocabulary + examples + hard-rules block, yet far below
    // the ~6700 an un-truncated 5000-char description would produce.
    expect(prompt.length).toBeLessThan(2500);
  });
});

describe('parseTaggingResponse — defensive batch parsing', () => {
  it('parses a batch response into per-bookmark items', () => {
    const out = parseTaggingResponse(
      JSON.stringify({
        results: [{ i: 1, tags: [{ name: '前端', confidence: 0.9, reason: 'React 文档' }], summary: '摘要' }],
      }),
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].index).toBe(0);
    expect(out[0].tags[0]).toMatchObject({ name: '前端', confidence: 0.9 });
    expect(out[0].summary).toBe('摘要');
  });

  it('accepts bare-string tags with a default confidence', () => {
    const out = parseTaggingResponse(JSON.stringify({ results: [{ i: 1, tags: ['React', 'vue'] }] }), 1);
    expect(out[0].tags).toEqual([
      { name: 'React', confidence: 0.6, reason: '模型建议', isNew: true },
      { name: 'vue', confidence: 0.6, reason: '模型建议', isNew: true },
    ]);
  });

  it('clamps confidence and ignores out-of-range indices', () => {
    const out = parseTaggingResponse(
      JSON.stringify({
        results: [
          { i: 1, tags: [{ name: '前端', confidence: 5 }] },
          { i: 9, tags: [{ name: '越界', confidence: 1 }] },
        ],
      }),
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].tags[0].confidence).toBe(1);
  });

  it('degrades to an empty result on junk, never throws', () => {
    expect(parseTaggingResponse(null, 1)).toEqual([]);
    expect(parseTaggingResponse('not json', 1)).toEqual([]);
    expect(parseTaggingResponse('{ not json', 1)).toEqual([]);
  });
});

describe('callProvider', () => {
  it('returns ok with extracted text on a successful call', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"results":[]}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const out = await callProvider(base, 'prompt', fetchImpl as never);
    expect(out.ok).toBe(true);
    expect(out.text).toBe('{"results":[]}');
  });

  it('surfaces a 401 as a fatal provider error with no text', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const out = await callProvider(base, 'prompt', fetchImpl as never);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.status).toBe(401);
      expect(out.error.message).toContain('Key');
    }
  });

  it('returns a network/timeout error (status null) rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted');
    });
    const out = await callProvider(base, 'prompt', fetchImpl as never);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.status).toBeNull();
      expect(out.error.message).toContain('超时');
    }
  });

  it('diagnoses an aborted partition signal as budget squeeze (抓取挤占)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted');
    });
    const spent = AbortSignal.abort();
    const out = await callProvider(base, 'prompt', fetchImpl as never, spent);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.status).toBeNull();
      expect(out.error.message).toContain('超时');
      expect(out.error.message).toContain('分区时间预算已用尽');
    }
  });

  it('diagnoses a request-ceiling timeout as a slow gateway (网关慢)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted');
    });
    const out = await callProvider(base, 'prompt', fetchImpl as never);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.status).toBeNull();
      expect(out.error.message).toContain('超时');
      expect(out.error.message).toContain('模型网关响应过慢');
    }
  });

  it('attributes a partition abort with a near-full model window to a slow model, not fetch', async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 700));
      throw new Error('aborted');
    });
    const spent = AbortSignal.abort();
    const out = await callProvider(base, 'prompt', fetchImpl as never, spent, {
      partitionBudgetMs: 6000,
      itemCount: 10,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.message).toContain('超时');
      expect(out.error.message).toContain('模型已拿满分配时间仍超时');
      expect(out.error.message).toContain('本网关处理偏慢');
      // per-bookmark rate is reported when itemCount is supplied
      expect(out.error.message).toContain('s/条');
    }
  });

  it('still blames fetch squeeze when the partition abort leaves little model time', async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 700));
      throw new Error('aborted');
    });
    const spent = AbortSignal.abort();
    const out = await callProvider(base, 'prompt', fetchImpl as never, spent, {
      partitionBudgetMs: 25000,
      itemCount: 10,
      // D-3: 只有打标轨道（有网页抓取阶段）才传 fetchesContent；
      // 「抓取挤占」诊断仅对该轨道成立。
      fetchesContent: true,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.message).toContain('超时');
      expect(out.error.message).toContain('分区时间预算已用尽');
      expect(out.error.message).toContain('网页抓取挤占');
    }
  });

  it('enforces the ceilings on parsed content', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: [
                    {
                      i: 1,
                      tags: [{ name: 'a'.repeat(MAX_TAG_LENGTH + 10), confidence: 0.5 }],
                      summary: 's'.repeat(MAX_SUMMARY_LENGTH + 50),
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const out = await callProvider(base, 'prompt', fetchImpl as never);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const parsed = parseTaggingResponse(out.text, 1);
      expect(parsed[0].tags[0].name.length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
      expect(parsed[0].summary!.length).toBe(MAX_SUMMARY_LENGTH);
    }
  });

  it('rejects an oversized body declared by content-length without reading it (D-5)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('x', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) },
      }),
    );
    const out = await callProvider(base, 'prompt', fetchImpl as never);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.status).toBeNull();
      expect(out.error.message).toContain('响应体过大');
    }
  });

  it('rejects an oversized body even when content-length lies (D-5)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const out = await callProvider(base, 'prompt', fetchImpl as never);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.message).toContain('响应体过大');
    }
  });

  it('surfaces a non-JSON 200 body as a parse error instead of throwing (D-5)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('data: {"choices":[]}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const out = await callProvider(base, 'prompt', fetchImpl as never);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.status).toBeNull();
      expect(out.error.message).toContain('不是有效 JSON');
    }
  });
});

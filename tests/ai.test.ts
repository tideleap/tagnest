import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SUMMARY_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  buildProviderRequest,
  buildPrompt,
  extractText,
  parseEnrichment,
  requestEnrichment,
  type AiConfig,
} from '../functions/_lib/ai';

const base: AiConfig = {
  provider: 'openai',
  baseUrl: null,
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  autoTag: true,
  autoSummarize: true,
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

  it('puts the Gemini key in the query string, not a header', () => {
    const req = buildProviderRequest({ ...base, provider: 'gemini', model: 'gemini-1.5' }, 'hi')!;
    expect(req.url).toContain('/models/gemini-1.5:generateContent');
    expect(req.url).toContain('key=sk-test');
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
});

describe('prompt', () => {
  it('asks only for the fields that are switched on', () => {
    expect(buildPrompt({ url: 'https://a.dev', title: 'A' }, { ...base, autoTag: false })).not.toContain(
      '"tags"',
    );
    expect(
      buildPrompt({ url: 'https://a.dev', title: 'A' }, { ...base, autoSummarize: false }),
    ).not.toContain('"summary"');
  });

  it('caps a long description instead of sending the whole page', () => {
    const prompt = buildPrompt(
      { url: 'https://a.dev', title: 'A', description: 'x'.repeat(5000) },
      base,
    );
    expect(prompt.length).toBeLessThan(2000);
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

describe('parseEnrichment', () => {
  it('extracts JSON even when the model wraps it in prose or fences', () => {
    const out = parseEnrichment('好的：\n```json\n{"summary":"一个工具","tags":["工具","效率"]}\n```');
    expect(out.summary).toBe('一个工具');
    expect(out.tags).toEqual(['工具', '效率']);
  });

  it('deduplicates case-insensitively and enforces the ceilings', () => {
    const out = parseEnrichment(
      JSON.stringify({
        summary: 's'.repeat(MAX_SUMMARY_LENGTH + 50),
        tags: ['React', 'react', 'REACT', 'a'.repeat(MAX_TAG_LENGTH + 10), 'b', 'c', 'd', 'e', 'f'],
      }),
    );
    expect(out.summary!.length).toBe(MAX_SUMMARY_LENGTH);
    expect(out.tags.length).toBeLessThanOrEqual(MAX_TAGS);
    expect(out.tags.filter((t) => t.toLowerCase() === 'react')).toHaveLength(1);
    expect(out.tags.every((t) => t.length <= MAX_TAG_LENGTH)).toBe(true);
  });

  it('degrades to an empty result on junk, never throws', () => {
    expect(parseEnrichment(null)).toEqual({ summary: null, tags: [] });
    expect(parseEnrichment('sorry, I cannot help')).toEqual({ summary: null, tags: [] });
    expect(parseEnrichment('{ not json')).toEqual({ summary: null, tags: [] });
    expect(parseEnrichment('{"tags":[1,2,null],"summary":42}')).toEqual({ summary: null, tags: [] });
  });
});

describe('requestEnrichment', () => {
  it('returns null on a provider error instead of surfacing it', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(requestEnrichment(base, { url: 'https://a.dev', title: 'A' }, fetchImpl as never))
      .resolves.toBeNull();
  });

  it('parses a successful completion end to end', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"summary":"摘要","tags":["笔记"]}' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const out = await requestEnrichment(base, { url: 'https://a.dev', title: 'A' }, fetchImpl as never);
    expect(out).toEqual({ summary: '摘要', tags: ['笔记'] });

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

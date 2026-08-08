import { describe, expect, it } from 'vitest';
import {
  buildSummarizationPrompt,
  buildTaggingPrompt,
  MAX_TOPIC_LENGTH,
  parseSummarizationResponse,
  parseTaggingResponse,
} from '../functions/_lib/ai/prompt';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';
import type { EnrichInput, Vocabulary } from '../functions/_lib/ai/types';

const vocab: Vocabulary = buildVocabulary([
  { name: '前端', id: 'fe', aliases: [], count: 12 },
  { name: '后端', id: 'be', aliases: [], count: 8 },
]);

const input: EnrichInput = {
  url: 'https://react.dev/learn',
  title: 'React 官方文档',
  description: 'Thinking in React 教程',
};

describe('parseTaggingResponse — modern schema', () => {
  it('parses topic and needsReview per item', () => {
    const raw = JSON.stringify({
      results: [
        {
          i: 1,
          tags: [{ name: '前端', confidence: 0.9, reason: 'React 文档', isNew: false }],
          summary: 'React 思考组件拆解的教程',
          topic: '前端框架',
          needsReview: true,
        },
      ],
    });
    const parsed = parseTaggingResponse(raw, 1);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].topic).toBe('前端框架');
    expect(parsed[0].needsReview).toBe(true);
    expect(parsed[0].tags[0]).toMatchObject({ name: '前端', isNew: false });
  });

  it('defaults needsReview to false when omitted', () => {
    const raw = JSON.stringify({
      results: [{ i: 1, tags: [{ name: '后端', confidence: 0.8, reason: 'r' }], topic: '服务端' }],
    });
    const parsed = parseTaggingResponse(raw, 1);
    expect(parsed[0].needsReview).toBe(false);
    expect(parsed[0].topic).toBe('服务端');
  });

  it('truncates an over-long topic to MAX_TOPIC_LENGTH', () => {
    const longTopic = 'x'.repeat(120);
    const raw = JSON.stringify({
      results: [{ i: 1, tags: [], topic: longTopic }],
    });
    const parsed = parseTaggingResponse(raw, 1);
    expect(parsed[0].topic).toHaveLength(MAX_TOPIC_LENGTH);
  });

  it('never throws on malformed output and yields no items', () => {
    expect(parseTaggingResponse('not json at all', 5)).toEqual([]);
    expect(parseTaggingResponse('{"results": [{"i": 99, "tags": []}]}', 5)).toEqual([]);
    expect(parseTaggingResponse(null, 5)).toEqual([]);
  });

  it('tolerates code fences and leading prose', () => {
    const raw = '好的，这是结果：\n```json\n{"results":[{"i":1,"tags":[{"name":"前端","confidence":0.9,"reason":"r"}],"topic":"前端框架"}]}\n```';
    const parsed = parseTaggingResponse(raw, 1);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].topic).toBe('前端框架');
  });
});

describe('parseSummarizationResponse — dedicated summary prompt', () => {
  it('parses summary and topic, mapping null summary to null', () => {
    const parsed = parseSummarizationResponse(
      JSON.stringify({ summary: '一句话摘要', topic: '前端框架' }),
    );
    expect(parsed).toEqual({ summary: '一句话摘要', topic: '前端框架' });
  });

  it('returns nulls on empty / malformed input', () => {
    expect(parseSummarizationResponse('')).toEqual({ summary: null, topic: null });
    expect(parseSummarizationResponse('garbage')).toEqual({ summary: null, topic: null });
  });
});

describe('buildTaggingPrompt — modernisation', () => {
  it('embeds the schema fields topic and needsReview', () => {
    const prompt = buildTaggingPrompt([input], vocab, {
      maxTags: 4,
      wantSummary: true,
    });
    expect(prompt).toContain('topic');
    expect(prompt).toContain('needsReview');
    expect(prompt).toContain('仅输出一个 JSON 对象');
  });

  it('includes few-shot examples and anti-examples', () => {
    const prompt = buildTaggingPrompt([input], vocab, {
      maxTags: 4,
      wantSummary: false,
    });
    expect(prompt).toContain('参考示例');
    expect(prompt).toContain('错误示例');
    // A concrete bad example from ANTI_EXAMPLES.
    expect(prompt).toContain('一个很好用的网站');
  });

  it('asks for summary only when wantSummary is set', () => {
    const withSummary = buildTaggingPrompt([input], vocab, { maxTags: 4, wantSummary: true });
    const without = buildTaggingPrompt([input], vocab, { maxTags: 4, wantSummary: false });
    expect(withSummary).toContain('summary');
    expect(without).not.toContain('"summary"');
  });

  it('lists the user taxonomy as a reusable label set', () => {
    const prompt = buildTaggingPrompt([input], vocab, { maxTags: 4, wantSummary: false });
    expect(prompt).toContain('前端');
    expect(prompt).toContain('后端');
  });
});

describe('buildSummarizationPrompt — dedicated summary prompt', () => {
  it('requests summary and topic for a single bookmark', () => {
    const prompt = buildSummarizationPrompt(input);
    expect(prompt).toContain('摘要');
    expect(prompt).toContain('topic');
    expect(prompt).toContain(input.url);
  });
});

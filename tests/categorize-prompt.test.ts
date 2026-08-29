import { describe, expect, it } from 'vitest';
import {
  buildCategorizePrompt,
  CATEGORIZE_PROMPT_VERSION,
  parseCategorizeResponse,
} from '../functions/_lib/ai/prompt';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';
import type { EnrichInput, Vocabulary } from '../functions/_lib/ai/types';

const vocab: Vocabulary = buildVocabulary([
  { name: '开发技术', id: 'dev', aliases: [], count: 30 },
  { name: '前端开发', id: 'fe', aliases: [], count: 12, parentId: 'dev' },
  { name: '在线工具', id: 'tools', aliases: [], count: 8 },
]);

const inputs: EnrichInput[] = [
  {
    url: 'https://react.dev/learn',
    title: 'React 官方文档',
    description: 'Thinking in React 教程',
    pageExcerpt: 'React lets you build user interfaces out of individual pieces called components.',
  },
  {
    url: 'https://www.figma.com/',
    title: 'Figma',
  },
];

describe('buildCategorizePrompt — single-placement semantics (C1-1/C1-2)', () => {
  it('demands exactly one placement per bookmark, not a tag list', () => {
    const prompt = buildCategorizePrompt(inputs, vocab);
    expect(prompt).toContain('有且只有一个归属');
    expect(prompt).toContain('这不是打标签');
    // The schema carries the path-array single-placement shape.
    expect(prompt).toContain('"path":["一级分类","二级分类","三级分类"]');
    // No multi-tag schema may leak into the categorize prompt.
    expect(prompt).not.toContain('"tags":[');
  });

  it('anchors the decision on page content, not existing tags (C1-2)', () => {
    const prompt = buildCategorizePrompt(inputs, vocab);
    expect(prompt).toContain('依据页面内容');
    expect(prompt).toContain('正文摘要');
    // The fetched excerpt is rendered for content-based classification.
    expect(prompt).toContain('components');
  });

  it('presents the existing tree as the target structure (C1-3)', () => {
    const prompt = buildCategorizePrompt(inputs, vocab);
    expect(prompt).toContain('已有分类树');
    expect(prompt).toContain('开发技术');
    expect(prompt).toContain('前端开发');
    // New nodes are allowed but must be flagged for review.
    expect(prompt).toContain('isNew');
    expect(prompt).toContain('优先归入已有节点');
  });

  it('falls back to bootstrap guidance when the tree is empty', () => {
    const prompt = buildCategorizePrompt(inputs, buildVocabulary([]));
    expect(prompt).toContain('还没有任何分类');
    expect(prompt).toContain('≤10 个一级分类');
  });

  it('includes few-shot examples with the path shape', () => {
    const prompt = buildCategorizePrompt(inputs, vocab);
    expect(prompt).toContain('参考示例');
    expect(prompt).toContain('开发技术 > 前端开发');
  });

  it('accepts custom few-shot examples', () => {
    const prompt = buildCategorizePrompt(inputs, vocab, {
      examples: [
        {
          title: '示例',
          url: 'https://example.com/',
          category: '自定义分类',
          subcategory: null,
          reason: '测试',
        },
      ],
    });
    expect(prompt).toContain('自定义分类');
    expect(prompt).not.toContain('Figma — 在线协作设计工具');
  });
});

describe('parseCategorizeResponse — documented schema', () => {
  it('parses a full single-placement row', () => {
    const raw = JSON.stringify({
      results: [
        {
          i: 1,
          category: '开发技术',
          subcategory: '前端开发',
          confidence: 0.92,
          reason: 'React 官方教程',
          isNew: false,
          needsReview: false,
        },
        { i: 2, category: '在线工具', subcategory: null, confidence: 0.8, reason: '设计工具', isNew: false },
      ],
    });
    const parsed = parseCategorizeResponse(raw, 2);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      index: 0,
      category: {
        category: '开发技术',
        subcategory: '前端开发',
        confidence: 0.92,
        reason: 'React 官方教程',
        isNew: false,
        needsReview: false,
      },
    });
    expect(parsed[1].category?.subcategory).toBeNull();
  });

  it('clamps confidence into [0,1] and defaults reason', () => {
    const raw = JSON.stringify({
      results: [{ i: 1, category: '开发技术', confidence: 3.5 }],
    });
    const parsed = parseCategorizeResponse(raw, 1);
    expect(parsed[0].category?.confidence).toBe(1);
    expect(parsed[0].category?.reason).toBe('模型分类');
  });

  it('truncates over-long category names to MAX_TAG_LENGTH (24)', () => {
    const raw = JSON.stringify({
      results: [{ i: 1, category: 'x'.repeat(80), confidence: 0.7 }],
    });
    const parsed = parseCategorizeResponse(raw, 1);
    expect(parsed[0].category?.category).toHaveLength(24);
  });
});

describe('parseCategorizeResponse — shape variants', () => {
  it('accepts a path array and splits it into category/subcategory', () => {
    const raw = JSON.stringify({
      results: [{ i: 1, path: ['开发技术', '前端开发'], confidence: 0.9 }],
    });
    const parsed = parseCategorizeResponse(raw, 1);
    expect(parsed[0].category).toMatchObject({
      category: '开发技术',
      subcategory: '前端开发',
    });
  });

  it('collapses a deeper-than-two path onto the second level', () => {
    const raw = JSON.stringify({
      results: [{ i: 1, path: ['开发技术', '前端开发', 'React'], confidence: 0.9 }],
    });
    const parsed = parseCategorizeResponse(raw, 1);
    expect(parsed[0].category?.category).toBe('开发技术');
    expect(parsed[0].category?.subcategory).toBe('前端开发 > React');
  });

  it('splits a folded "A > B" category string', () => {
    const raw = JSON.stringify({
      results: [{ i: 1, category: '开发技术 > 前端开发', confidence: 0.88 }],
    });
    const parsed = parseCategorizeResponse(raw, 1);
    expect(parsed[0].category).toMatchObject({
      category: '开发技术',
      subcategory: '前端开发',
    });
  });

  it('tolerates code fences, prose and array-root responses', () => {
    const fenced =
      '好的：\n```json\n{"results":[{"i":1,"category":"在线工具","confidence":0.8}]}\n```';
    expect(parseCategorizeResponse(fenced, 1)[0].category?.category).toBe('在线工具');

    const arrayRoot = '[{"i":1,"category":"在线工具","confidence":0.8}]';
    expect(parseCategorizeResponse(arrayRoot, 1)[0].category?.category).toBe('在线工具');
  });
});

describe('parseCategorizeResponse — degradation (C1-7)', () => {
  it('never throws on malformed output', () => {
    expect(parseCategorizeResponse(null, 3)).toEqual([]);
    expect(parseCategorizeResponse('not json', 3)).toEqual([]);
    expect(parseCategorizeResponse('{"results":[{"i":99,"category":"x"}]}', 3)).toEqual([]);
  });

  it('yields category:null for rows without a usable name', () => {
    const raw = JSON.stringify({
      results: [
        { i: 1, category: '', confidence: 0.9 },
        { i: 2, category: '在线工具', confidence: 0.7 },
      ],
    });
    const parsed = parseCategorizeResponse(raw, 2);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].category).toBeNull();
    expect(parsed[1].category?.category).toBe('在线工具');
  });
});

describe('CATEGORIZE_PROMPT_VERSION', () => {
  it('is a date tag distinct from the tagging prompt version', () => {
    expect(CATEGORIZE_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachParentTags,
  buildTreePrompt,
  parseTreeResponse,
  REBALANCE_THRESHOLD,
  shouldWarnRebalance,
  synthesizeTaxonomy,
} from '../functions/_lib/ai/taxonomy-tree';
import { callProvider } from '../functions/_lib/ai/providers';
import type { RawCandidate } from '../functions/_lib/ai/types';

vi.mock('../functions/_lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../functions/_lib/ai/providers')>();
  return { ...actual, callProvider: vi.fn() };
});
const mockedCall = vi.mocked(callProvider);

const modelConfig = {
  provider: 'openai' as const,
  baseUrl: null,
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  autoTag: true,
  autoSummarize: false,
  autoApplyThreshold: 1,
  maxTags: 4,
};

beforeEach(() => mockedCall.mockReset());
afterEach(() => mockedCall.mockReset());

describe('buildTreePrompt (P0-1)', () => {
  it('embeds the tag list and the level/category bounds', () => {
    const p = buildTreePrompt([
      { name: 'React', count: 12 },
      { name: 'Vue', count: 3 },
    ]);
    expect(p).toContain('React（出现 12 次）');
    expect(p).toContain('最多 3 层');
    expect(p).toContain('最多 10 个一级分类');
    expect(p).toContain('仅输出一个 JSON 数组');
  });
});

describe('parseTreeResponse (P0-1)', () => {
  it('parses an array-root taxonomy', () => {
    const tree = parseTreeResponse('[{"name":"前端","children":[{"name":"React"},{"name":"Vue"}]}]');
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('前端');
    expect(tree[0].children.map((c) => c.name)).toEqual(['React', 'Vue']);
  });

  it('parses an object wrapper ({tree:[...]})', () => {
    const tree = parseTreeResponse('{"tree":[{"name":"后端","children":[{"name":"Go"}]}]}');
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].name).toBe('Go');
  });

  it('strips fences and prose', () => {
    const raw = '好的：\n```json\n[{"name":"工具","children":[{"name":"CLI"}]}]\n```';
    const tree = parseTreeResponse(raw);
    expect(tree[0].name).toBe('工具');
    expect(tree[0].children[0].name).toBe('CLI');
  });

  it('caps depth at 3 levels', () => {
    const raw = JSON.stringify([
      {
        name: 'A',
        children: [
          {
            name: 'B',
            children: [{ name: 'C', children: [{ name: 'D', children: [{ name: 'E' }] }] }],
          },
        ],
      },
    ]);
    const tree = parseTreeResponse(raw);
    // A -> B -> C (D dropped because it would be level 4)
    expect(tree[0].children[0].name).toBe('B');
    expect(tree[0].children[0].children[0].name).toBe('C');
    expect(tree[0].children[0].children[0].children).toEqual([]);
  });

  it('caps the top level at 10 categories', () => {
    const top = Array.from({ length: 12 }, (_, i) => ({ name: `Cat${i}` }));
    const tree = parseTreeResponse(JSON.stringify(top));
    expect(tree).toHaveLength(10);
  });

  it('returns [] on malformed input', () => {
    expect(parseTreeResponse('not json')).toEqual([]);
    expect(parseTreeResponse(null)).toEqual([]);
  });
});

describe('attachParentTags (P0-1 — 补父标签)', () => {
  const tree = parseTreeResponse(
    '[{"name":"前端","children":[{"name":"React"},{"name":"Vue"}]},{"name":"后端","children":[{"name":"Go"}]}]',
  );

  const raw = (name: string): RawCandidate => ({
    name,
    confidence: 0.9,
    source: 'model',
    reason: 'r',
  });

  it('adds the immediate parent of a leaf tag', () => {
    const out = attachParentTags([raw('React')], tree);
    const names = out.map((t) => t.name);
    expect(names).toContain('React');
    expect(names).toContain('前端');
    const parent = out.find((t) => t.name === '前端');
    expect(parent?.reason).toContain('父级分类');
  });

  it('does not duplicate a parent that is already present', () => {
    const out = attachParentTags([raw('React'), raw('前端')], tree);
    const parents = out.filter((t) => t.name === '前端');
    expect(parents).toHaveLength(1);
  });

  it('leaves unmatched tags untouched', () => {
    const out = attachParentTags([raw('Docker')], tree);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Docker');
  });

  it('does not add a self-parent cycle', () => {
    const selfTree = parseTreeResponse('[{"name":"X","children":[{"name":"X"}]}]');
    const out = attachParentTags([raw('X')], selfTree);
    const xs = out.filter((t) => t.name === 'X');
    expect(xs).toHaveLength(1);
  });
});

describe('synthesizeTaxonomy (P0-1)', () => {
  it('skips synthesis below the signal threshold without calling the model', async () => {
    const tags = Array.from({ length: 7 }, (_, i) => ({ name: `T${i}`, count: 1 }));
    const out = await synthesizeTaxonomy(tags, modelConfig as never);
    expect(out.tree).toEqual([]);
    expect(out.fatal).toBe(false);
    expect(mockedCall).not.toHaveBeenCalled();
  });

  it('returns the tree when the model responds', async () => {
    const tags = Array.from({ length: 9 }, (_, i) => ({ name: `T${i}`, count: i + 1 }));
    mockedCall.mockResolvedValueOnce({
      ok: true,
      text: '[{"name":"组","children":[{"name":"T0"}]}]',
    });
    const out = await synthesizeTaxonomy(tags, modelConfig as never);
    expect(out.fatal).toBe(false);
    expect(out.tree).toHaveLength(1);
    expect(out.tree[0].children[0].name).toBe('T0');
  });

  it('propagates a fatal provider error', async () => {
    const tags = Array.from({ length: 9 }, (_, i) => ({ name: `T${i}`, count: 1 }));
    mockedCall.mockResolvedValueOnce({
      ok: false,
      error: { status: 401, message: 'API Key 无效' },
    });
    const out = await synthesizeTaxonomy(tags, modelConfig as never);
    expect(out.fatal).toBe(true);
    expect(out.error).toContain('API Key');
  });

  it('degrades to an empty tree when the model returns nothing parseable', async () => {
    const tags = Array.from({ length: 9 }, (_, i) => ({ name: `T${i}`, count: 1 }));
    mockedCall.mockResolvedValue({ ok: true, text: 'no json here' });
    const out = await synthesizeTaxonomy(tags, modelConfig as never);
    expect(out.fatal).toBe(false);
    expect(out.tree).toEqual([]);
  });
});

describe('shouldWarnRebalance (P2-2)', () => {
  it('uses a 30% threshold', () => {
    expect(REBALANCE_THRESHOLD).toBe(0.3);
  });

  it('never warns when no new tags were introduced', () => {
    expect(shouldWarnRebalance(0, 100)).toBe(false);
    expect(shouldWarnRebalance(0, 0)).toBe(false);
  });

  it('warns when new tags reach the threshold share', () => {
    // 3 new / (3 + 7 existing) = 30% → warn.
    expect(shouldWarnRebalance(3, 7)).toBe(true);
    // 5 new / (5 + 5) = 50% → warn.
    expect(shouldWarnRebalance(5, 5)).toBe(true);
  });

  it('does not warn below the threshold', () => {
    // 2 new / (2 + 18) = 10% → no warn.
    expect(shouldWarnRebalance(2, 18)).toBe(false);
    // 29 new / (29 + 71) = 29% → no warn.
    expect(shouldWarnRebalance(29, 71)).toBe(false);
  });

  it('warns for a first run into an empty taxonomy', () => {
    // All tags are new: 10 / (10 + 0) = 100% → warn.
    expect(shouldWarnRebalance(10, 0)).toBe(true);
  });
});

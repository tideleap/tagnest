import { describe, expect, it } from 'vitest';
import { classifyTag, computeTagHierarchy, type FlatTag } from '../functions/_lib/ai/grouping';

const tag = (id: string, name: string, parentId: string | null = null, count = 1): FlatTag => ({
  id,
  name,
  count,
  parentId,
});

describe('classifyTag — 一级/二级 mapping', () => {
  it('classifies a frontend tag into 开发技术 > 前端开发', () => {
    expect(classifyTag('React 前端')).toEqual(['开发技术', '前端开发']);
  });
  it('classifies a database tag into 开发技术 > 数据与存储', () => {
    expect(classifyTag('SQL 优化')).toEqual(['开发技术', '数据与存储']);
  });
  it('classifies a design tag into 设计与创意 with UI subcategory', () => {
    expect(classifyTag('UI 设计规范')).toEqual(['设计与创意', '界面与交互']);
  });
  it('classifies a doc tag into 学习资料 > 文档参考', () => {
    expect(classifyTag('Python 官方文档')).toEqual(['学习资料', '文档参考']);
  });
  it('classifies an AI tag into 人工智能', () => {
    expect(classifyTag('大模型')).toEqual(['人工智能', '大模型']);
  });
  it('classifies a cloud tag into 运维与云', () => {
    expect(classifyTag('Docker 容器')).toEqual(['运维与云', '容器编排']);
  });
  it('returns null for an unclassified tag', () => {
    expect(classifyTag('秘密代号X')).toBeNull();
  });
});

describe('computeTagHierarchy — 3-level assignment', () => {
  const tags: FlatTag[] = [
    tag('r', 'React 前端'),
    tag('v', 'Vue 前端'),
    tag('d', 'PostgreSQL 数据库'),
    tag('ui', 'UI 规范'),
    tag('ai', '大模型'),
    tag('uniq', '无归类标签'),
  ];

  const result = computeTagHierarchy(tags);

  it('assigns frontend tags under 开发技术 > 前端开发', () => {
    const r = result.assignments.find((a) => a.tagId === 'r');
    expect(r).toEqual({ tagId: 'r', category: '开发技术', subcategory: '前端开发' });
    const v = result.assignments.find((a) => a.tagId === 'v');
    expect(v?.category).toBe('开发技术');
    expect(v?.subcategory).toBe('前端开发');
  });

  it('assigns database tag under a sibling subcategory', () => {
    const d = result.assignments.find((a) => a.tagId === 'd');
    expect(d?.subcategory).toBe('数据与存储');
    expect(d?.category).toBe('开发技术');
  });

  it('assigns AI tags under 人工智能', () => {
    const ai = result.assignments.find((a) => a.tagId === 'ai');
    expect(ai?.category).toBe('人工智能');
    expect(ai?.subcategory).toBe('大模型');
  });

  it('leaves an unclassified tag untouched', () => {
    expect(result.untouchedCount).toBe(1);
    expect(result.assignments.find((a) => a.tagId === 'uniq')).toBeUndefined();
  });

  it('reports the distinct category / subcategory names to create', () => {
    expect(result.categories).toContain('开发技术');
    expect(result.categories).toContain('设计与创意');
    expect(result.categories).toContain('人工智能');
    expect(result.subcategories).toContainEqual({ category: '开发技术', sub: '前端开发' });
    expect(result.subcategories).toContainEqual({ category: '开发技术', sub: '数据与存储' });
  });

  it('produces a human summary', () => {
    expect(result.summary).toContain('开发技术 > 前端开发');
    expect(result.summary).toContain('设计与创意 > 界面与交互');
  });
});

describe('computeTagHierarchy — depth guard', () => {
  it('never pushes a tag that is already nested to depth limit', () => {
    // l1 -> l2 -> leaf: the leaf React is already at depth 2 (MAX_DEPTH), so
    // the engine must leave it untouched rather than nest it deeper.
    const tags: FlatTag[] = [
      tag('l1', '技术', null),
      tag('l2', '前端开发', 'l1'),
      tag('react', 'React', 'l2'),
    ];
    const result = computeTagHierarchy(tags);
    // 'React' sits at depth 2 already → never reassigned (depth guard).
    expect(result.assignments.find((a) => a.tagId === 'react')).toBeUndefined();
  });
});

describe('computeTagHierarchy — 同一标签归并准确性 (merge accuracy)', () => {
  // A realistic batch: several tags should collapse into the same bucket, a
  // couple into a sibling bucket, and one must stay unclassified. This is the
  // exact property the user cares about — bookmarks sharing a tag intent must
  // land in one, and only one, 一级 > 二级 slot.
  const tags: FlatTag[] = [
    tag('r', 'React 前端'),
    tag('v', 'Vue 前端'),
    tag('css', 'CSS 技巧'),
    tag('pg', 'PostgreSQL 数据库'),
    tag('ai1', '大模型应用'),
    tag('ai2', 'NLP 自然语言处理'),
    tag('unknown', '神秘代号'),
  ];
  const result = computeTagHierarchy(tags);

  it('groups sibling tags sharing one intent under the same 一级 > 二级', () => {
    for (const id of ['r', 'v', 'css']) {
      const a = result.assignments.find((x) => x.tagId === id);
      expect(a?.category).toBe('开发技术');
      expect(a?.subcategory).toBe('前端开发');
    }
  });

  it('assigns each tag to exactly one category (no double-merge across buckets)', () => {
    const ids = result.assignments.map((a) => a.tagId);
    expect(new Set(ids).size).toBe(ids.length); // every tag id appears once
  });

  it('keeps a subcategory bound to its single parent category', () => {
    const frontend = result.subcategories.filter((s) => s.sub === '前端开发');
    expect(frontend).toHaveLength(1);
    expect(frontend[0].category).toBe('开发技术');
  });

  it('levels the AI tags under 人工智能 without leaking into 开发技术', () => {
    for (const id of ['ai1', 'ai2']) {
      const a = result.assignments.find((x) => x.tagId === id);
      expect(a?.category).toBe('人工智能');
    }
    // 人工智能 must not be reused as a sub of 开发技术.
    expect(result.subcategories.some((s) => s.category === '开发技术' && s.sub === '人工智能')).toBe(false);
  });

  it('is deterministic and safe to re-run (idempotent)', () => {
    const again = computeTagHierarchy(tags);
    expect(again.assignments).toEqual(result.assignments);
    expect(again.categories).toEqual(result.categories);
    expect(again.subcategories).toEqual(result.subcategories);
    expect(again.untouchedCount).toBe(result.untouchedCount);
  });

  it('counts unclassified tags as untouched', () => {
    expect(result.untouchedCount).toBe(1);
    expect(result.assignments.find((a) => a.tagId === 'unknown')).toBeUndefined();
  });

  it('produces a well-formed 3-level summary (一级 > 二级)', () => {
    expect(result.summary).toContain('开发技术 > 前端开发');
    expect(result.summary).toContain('人工智能 > 大模型');
    // Every subcategory in the summary must also be present in the pair list.
    for (const s of result.subcategories) {
      expect(result.summary).toContain(`${s.category} > ${s.sub}`);
    }
  });
});

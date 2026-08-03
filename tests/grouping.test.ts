import { describe, expect, it } from 'vitest';
import { classifyTag, computeTagHierarchy, type FlatTag } from '../functions/_lib/ai/grouping';

const tag = (id: string, name: string, parentId: string | null = null, count = 1): FlatTag => ({
  id,
  name,
  count,
  parentId,
});

describe('classifyTag — 一级/二级 mapping', () => {
  it('classifies a frontend tag into 技术 > 前端开发', () => {
    expect(classifyTag('React 前端')).toEqual(['技术', '前端开发']);
  });
  it('classifies a database tag into 技术 > 数据与存储', () => {
    expect(classifyTag('SQL 优化')).toEqual(['技术', '数据与存储']);
  });
  it('classifies a design tag into 设计 with UI subcategory', () => {
    expect(classifyTag('UI 设计规范')).toEqual(['设计', '界面设计']);
  });
  it('classifies a doc tag into 学习 > 文档参考', () => {
    expect(classifyTag('Python 官方文档')).toEqual(['学习', '文档参考']);
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
    tag('uniq', '无归类标签'),
  ];

  const result = computeTagHierarchy(tags);

  it('assigns frontend tags under 技术 > 前端开发', () => {
    const r = result.assignments.find((a) => a.tagId === 'r');
    expect(r).toEqual({ tagId: 'r', category: '技术', subcategory: '前端开发' });
    const v = result.assignments.find((a) => a.tagId === 'v');
    expect(v?.category).toBe('技术');
    expect(v?.subcategory).toBe('前端开发');
  });

  it('assigns database tag under a sibling subcategory', () => {
    const d = result.assignments.find((a) => a.tagId === 'd');
    expect(d?.subcategory).toBe('数据与存储');
    expect(d?.category).toBe('技术');
  });

  it('leaves an unclassified tag untouched', () => {
    expect(result.untouchedCount).toBe(1);
    expect(result.assignments.find((a) => a.tagId === 'uniq')).toBeUndefined();
  });

  it('reports the distinct category / subcategory names to create', () => {
    expect(result.categories).toContain('技术');
    expect(result.categories).toContain('设计');
    expect(result.subcategories).toContainEqual({ category: '技术', sub: '前端开发' });
    expect(result.subcategories).toContainEqual({ category: '技术', sub: '数据与存储' });
  });

  it('produces a human summary', () => {
    expect(result.summary).toContain('技术 > 前端开发');
    expect(result.summary).toContain('设计 > 界面设计');
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

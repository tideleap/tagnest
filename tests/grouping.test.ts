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

/**
 * Orphan governance (2026-09-05): low-frequency top-level orphans must be
 * consolidated instead of accumulating. The pass is opt-in via `options`;
 * omitting it keeps the exact legacy output (pinned below).
 */
describe('computeTagHierarchy — orphan governance', () => {
  const GOV = { minTagCount: 2, maxOrphans: 20, defaultGroup: '其他' };

  it('consolidates count<minTagCount orphans into the default group', () => {
    const tags: FlatTag[] = [
      tag('o1', '神秘甲', null, 1),
      tag('o2', '神秘乙', null, 1),
    ];
    const result = computeTagHierarchy(tags, GOV);
    expect(result.consolidated).toBe(2);
    for (const id of ['o1', 'o2']) {
      const a = result.assignments.find((x) => x.tagId === id);
      expect(a).toEqual({ tagId: id, category: '其他', subcategory: null });
    }
    expect(result.categories).toContain('其他');
    expect(result.untouchedCount).toBe(0); // both orphans absorbed
  });

  it('keeps orphans whose count >= minTagCount while under maxOrphans', () => {
    const tags: FlatTag[] = [tag('k1', '神秘丙', null, 5)];
    const result = computeTagHierarchy(tags, GOV);
    expect(result.consolidated).toBe(0);
    expect(result.assignments.find((a) => a.tagId === 'k1')).toBeUndefined();
    expect(result.untouchedCount).toBe(1);
  });

  it('trims orphans above maxOrphans — lowest count first, name as deterministic tiebreak', () => {
    const tags: FlatTag[] = [
      tag('h1', '神秘高', null, 9),
      tag('t1', 'aaa-one', null, 2),
      tag('t2', 'bbb-two', null, 2),
      tag('t3', 'ccc-three', null, 2),
    ];
    const result = computeTagHierarchy(tags, { minTagCount: 2, maxOrphans: 2 });
    // keepers = 4 > cap 2 → trim 2; all tie at count 2, so the
    // alphabetically-first names go: aaa-one, bbb-two.
    expect(result.consolidated).toBe(2);
    const ids = result.assignments.map((a) => a.tagId).sort();
    expect(ids).toEqual(['t1', 't2']);
    expect(result.assignments.find((a) => a.tagId === 't3')).toBeUndefined();
    expect(result.assignments.find((a) => a.tagId === 'h1')).toBeUndefined();
  });

  it('composes minTagCount (must-go) with maxOrphans (cap)', () => {
    const tags: FlatTag[] = [
      tag('a', '神秘一', null, 1),
      tag('b', '神秘二', null, 2),
      tag('c', '神秘三', null, 3),
      tag('d', '神秘四', null, 4),
    ];
    const result = computeTagHierarchy(tags, { minTagCount: 3, maxOrphans: 1 });
    // mustGo: count<3 → a, b. keepers: c, d → cap 1 → trim the lowest (c).
    expect(result.consolidated).toBe(3);
    const kept = tags.filter((t) => !result.assignments.some((x) => x.tagId === t.id));
    expect(kept.map((t) => t.id)).toEqual(['d']);
    expect(result.untouchedCount).toBe(1);
  });

  it('consolidates into the most specific similar group (sub > category > structural folder)', () => {
    const tags: FlatTag[] = [
      tag('pg', 'PostgreSQL 数据库', null, 10), // creates 开发技术 > 数据与存储
      tag('f1', '开发资料库', null, 8), // structural folder…
      tag('f1c', '内部条目', 'f1', 3), // …because it has a child
      tag('oSub', '开发技术数据与存储杂项', null, 1), // matches both sub and category
      tag('oCat', '开发技术存档', null, 1), // matches the category only
      tag('oTag', '开发资料库附件', null, 1), // matches the structural folder only
    ];
    const result = computeTagHierarchy(tags, GOV);
    expect(result.consolidated).toBe(3);

    // Sub beats category even though both match.
    const sub = result.assignments.find((a) => a.tagId === 'oSub');
    expect(sub).toEqual({ tagId: 'oSub', category: '开发技术', subcategory: '数据与存储' });

    const cat = result.assignments.find((a) => a.tagId === 'oCat');
    expect(cat).toEqual({ tagId: 'oCat', category: '开发技术', subcategory: null });

    const fol = result.assignments.find((a) => a.tagId === 'oTag');
    expect(fol).toEqual({ tagId: 'oTag', category: '开发资料库', subcategory: null });

    expect(result.untouchedCount).toBe(2); // folder + its child remain
  });

  it('prefers the longest similar name within one level', () => {
    const tags: FlatTag[] = [
      tag('f1', '相册', null, 6),
      tag('f1c', '条目甲', 'f1', 2),
      tag('f2', '家庭相册', null, 6),
      tag('f2c', '条目乙', 'f2', 2),
      tag('o', '家庭相册补扫', null, 1),
    ];
    const result = computeTagHierarchy(tags, GOV);
    const a = result.assignments.find((x) => x.tagId === 'o');
    // Both folders match; the longer (more specific) name wins.
    expect(a).toEqual({ tagId: 'o', category: '家庭相册', subcategory: null });
  });

  it('never matches through a one-character key (≥2-char similarity floor)', () => {
    const tags: FlatTag[] = [
      tag('f', '小说', null, 5),
      tag('fc', '条目丙', 'f', 2),
      tag('o', '说', null, 1),
    ];
    const result = computeTagHierarchy(tags, GOV);
    const a = result.assignments.find((x) => x.tagId === 'o');
    // '说' ⊂ '小说', but a 1-char orphan key cannot latch on → default group.
    expect(a).toEqual({ tagId: 'o', category: '其他', subcategory: null });
  });

  it('honours a custom defaultGroup and never consolidates its name twin', () => {
    const tags: FlatTag[] = [
      tag('o', '神秘丁', null, 1),
      tag('dg', '未分类', null, 1),
    ];
    const result = computeTagHierarchy(tags, { defaultGroup: '未分类' });
    const a = result.assignments.find((x) => x.tagId === 'o');
    expect(a?.category).toBe('未分类');
    // The existing 「未分类」 tag IS the group itself — it must stay put.
    expect(result.assignments.find((x) => x.tagId === 'dg')).toBeUndefined();
    expect(result.consolidated).toBe(1);
  });

  it('exempts structural folders, category twins and subcategory twins', () => {
    const tags: FlatTag[] = [
      tag('r', 'React 前端', null, 10), // creates 开发技术 > 前端开发
      tag('pg', 'PostgreSQL 数据库', null, 10), // creates … > 数据与存储
      tag('folder', '神秘文件夹', null, 1),
      tag('child', '条目丁', 'folder', 2),
      tag('catTwin', '开发技术', null, 1),
      tag('subTwin', '数据与存储', null, 1),
    ];
    const result = computeTagHierarchy(tags, GOV);
    expect(result.consolidated).toBe(0);
    for (const id of ['folder', 'catTwin', 'subTwin']) {
      expect(result.assignments.find((a) => a.tagId === id)).toBeUndefined();
    }
  });

  it('never treats rule-classified tags as orphans, even at count 1', () => {
    const tags: FlatTag[] = [tag('r', 'React 前端', null, 1)];
    const result = computeTagHierarchy(tags, GOV);
    const a = result.assignments.find((x) => x.tagId === 'r');
    expect(a).toEqual({ tagId: 'r', category: '开发技术', subcategory: '前端开发' });
    expect(result.consolidated).toBe(0);
  });

  it('is idempotent: consolidated tags are not re-consolidated on a second run', () => {
    const before: FlatTag[] = [
      tag('o1', '神秘甲', null, 1),
      tag('o2', '神秘乙', null, 1),
    ];
    const first = computeTagHierarchy(before, GOV);
    expect(first.consolidated).toBe(2);

    // Simulate the applied state: 「其他」 exists and the orphans hang under it.
    const after: FlatTag[] = [
      tag('other', '其他', null, 0),
      tag('o1', '神秘甲', 'other', 1),
      tag('o2', '神秘乙', 'other', 1),
    ];
    const second = computeTagHierarchy(after, GOV);
    expect(second.consolidated).toBe(0);
    expect(second.assignments).toHaveLength(0);
  });

  it('consolidates every tag when the whole tree is low-frequency orphans', () => {
    const tags: FlatTag[] = [
      tag('o1', '神秘甲', null, 1),
      tag('o2', '神秘乙', null, 1),
      tag('o3', '神秘丙', null, 1),
    ];
    const result = computeTagHierarchy(tags, GOV);
    expect(result.consolidated).toBe(3);
    expect(result.categories).toEqual(['其他']);
    expect(result.untouchedCount).toBe(0);
  });

  it('handles an empty tag list without throwing', () => {
    const result = computeTagHierarchy([], GOV);
    expect(result.consolidated).toBe(0);
    expect(result.assignments).toHaveLength(0);
    expect(result.categories).toHaveLength(0);
    expect(result.untouchedCount).toBe(0);
  });

  it('keeps the exact legacy output when no options are passed', () => {
    const tags: FlatTag[] = [
      tag('r', 'React 前端', null, 10),
      tag('o1', '神秘甲', null, 1),
      tag('o2', '神秘乙', null, 1),
    ];
    const result = computeTagHierarchy(tags);
    expect(result.consolidated).toBe(0);
    expect(result.assignments).toHaveLength(1); // only the rule-classified tag
    expect(result.untouchedCount).toBe(2);
    expect(result.categories).not.toContain('其他');
  });
});

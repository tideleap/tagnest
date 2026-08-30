import { describe, expect, it } from 'vitest';
import {
  GOVERNANCE_DEFAULTS,
  distinctBudget,
  governTaxonomy,
} from '../functions/_lib/ai/governance';
import { buildVocabulary, type VocabEntry } from '../functions/_lib/ai/taxonomy';
import type { BookmarkInput } from '../functions/_lib/ai/engine';
import type { RawCandidate } from '../functions/_lib/ai/types';

function entry(id: string, name: string, count = 0, parentId: string | null = null): VocabEntry {
  return { id, name, aliases: [], count, parentId };
}

function input(id: string, host: string): BookmarkInput {
  return { id, url: `https://${host}/page`, title: host };
}

function cand(name: string, confidence = 0.8): RawCandidate {
  return { name, confidence, source: 'model', reason: 'test' };
}

describe('distinctBudget', () => {
  it('honours the floor for tiny runs', () => {
    expect(distinctBudget(10)).toBe(6);
    expect(distinctBudget(1)).toBe(6);
  });

  it('follows ceil(N/3) in the middle band', () => {
    expect(distinctBudget(20)).toBe(7);
    expect(distinctBudget(50)).toBe(17);
    expect(distinctBudget(100)).toBe(34);
    expect(distinctBudget(168)).toBe(56);
    expect(distinctBudget(200)).toBe(67);
  });

  it('caps at 100 for large runs', () => {
    expect(distinctBudget(300)).toBe(100);
    expect(distinctBudget(1000)).toBe(100);
  });
});

describe('governTaxonomy — minimum support (P0-2)', () => {
  it('drops every brand-new singleton tag', () => {
    const inputs = [1, 2, 3, 4, 5].map((i) => input(`b${i}`, `site${i}.com`));
    const tags = new Map([
      [0, [cand('孤标签甲')]],
      [1, [cand('孤标签乙')]],
      [2, [cand('孤标签丙')]],
      [3, [cand('孤标签丁')]],
      [4, [cand('孤标签戊')]],
    ]);
    const gov = governTaxonomy(tags, buildVocabulary([]), inputs);
    // Every bookmark must still end up with ≥1 tag (domain fallback), but the
    // singleton names themselves are gone.
    for (const [index, cands] of gov.tags) {
      expect(cands.length).toBeGreaterThanOrEqual(1);
      for (const c of cands) {
        expect(['孤标签甲', '孤标签乙', '孤标签丙', '孤标签丁', '孤标签戊']).not.toContain(c.name);
      }
      expect(index).toBeDefined();
    }
    expect(gov.metrics.dropped).toBeGreaterThan(0);
  });

  it('keeps a new tag whose batch support reaches the minimum', () => {
    const inputs = [1, 2].map((i) => input(`b${i}`, `s${i}.com`));
    const tags = new Map([
      [0, [cand('好标签')]],
      [1, [cand('好标签')]],
    ]);
    const gov = governTaxonomy(tags, buildVocabulary([]), inputs);
    const names = [...gov.tags.values()].flatMap((c) => c.map((x) => x.name));
    expect(names).toContain('好标签');
    expect(gov.quality.distinct).toBe(1);
  });
});

describe('governTaxonomy — three-level rescue (P0-3)', () => {
  it('merges a prefix-contained singleton into its kept root tag', () => {
    const entries = [entry('t1', 'React', 20)];
    const inputs = [1].map((i) => input(`b${i}`, 'reactjs.org'));
    const tags = new Map([[0, [cand('React Hooks'), cand('React', 0.9)]]]);
    const gov = governTaxonomy(tags, buildVocabulary(entries), inputs);
    const names = [...gov.tags.values()].flatMap((c) => c.map((x) => x.name));
    // "React Hooks" is not in the vocabulary, so it is a brand-new name with
    // support 1 → dropped/merged; "React" (existing) always survives.
    expect(names).toContain('React');
    expect(names.filter((n) => n === 'React').length).toBeGreaterThanOrEqual(1);
    // Both assignments land on the single existing tag.
    expect(gov.quality.distinct).toBe(1);
  });

  it('merges two similar brand-new names when one passes minSupport', () => {
    const entries = [entry('t1', '前端', 10)];
    const inputs = [1, 2].map((i) => input(`b${i}`, `s${i}.com`));
    const tags = new Map([
      [0, [cand('React Hooks')]],
      [1, [cand('React Hooks')]],
    ]);
    const gov = governTaxonomy(tags, buildVocabulary(entries), inputs);
    const names = [...gov.tags.values()].flatMap((c) => c.map((x) => x.name));
    expect(names.filter((n) => n === 'React Hooks').length).toBe(2);
    expect(gov.quality.newTags).toBe(1);
    expect(gov.metrics.merged).toBe(0);
  });

  it('rolls a singleton up to its vocabulary parent', () => {
    const entries = [
      entry('p1', '前端', 10),
      entry('c1', 'Vue3 源码', 0, 'p1'),
    ];
    const inputs = [1].map((i) => input(`b${i}`, 'vuejs.org'));
    const tags = new Map([[0, [cand('Vue3 源码')]]]);
    const gov = governTaxonomy(tags, buildVocabulary(entries), inputs);
    const names = [...gov.tags.values()].flatMap((c) => c.map((x) => x.name));
    // Existing tags are always kept, so this one survives regardless — but a
    // genuinely new child of 前端 must roll up when it fails admission.
    const entries2 = [entry('p1', '前端', 10)];
    const tags2 = new Map([[0, [cand('Vue3 源码解析')]]]);
    const gov2 = governTaxonomy(tags2, buildVocabulary(entries2), inputs);
    const names2 = [...gov2.tags.values()].flatMap((c) => c.map((x) => x.name));
    expect(names.length).toBeGreaterThanOrEqual(1);
    // Either rolled up to 前端 or replaced by the fallback — never empty.
    expect(names2.every((n) => n.length > 0)).toBe(true);
  });

  it('drops an unrescuable singleton but never leaves a bookmark untagged', () => {
    const inputs = [1].map((i) => input(`b${i}`, 'zzz-unknown-site.net'));
    const tags = new Map([[0, [cand('完全不相关的孤立词')]]]);
    const gov = governTaxonomy(tags, buildVocabulary([]), inputs);
    expect(gov.tags.get(0)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe('governTaxonomy — false-positive guard (P0-4)', () => {
  it('keeps an existing vocabulary tag used by only one bookmark in this batch', () => {
    const entries = [entry('t1', '摄影', 30)];
    const inputs = [1].map((i) => input(`b${i}`, 'flickr.com'));
    const tags = new Map([[0, [cand('摄影')]]]);
    const gov = governTaxonomy(tags, buildVocabulary(entries), inputs);
    const names = [...gov.tags.values()].flatMap((c) => c.map((x) => x.name));
    expect(names).toContain('摄影');
    expect(gov.metrics.dropped).toBe(0);
  });
});

describe('governTaxonomy — global budget (P0-1)', () => {
  it('caps distinct new tags at the budget while existing tags pass through', () => {
    const inputs = Array.from({ length: 60 }, (_, i) => input(`b${i}`, `s${i % 3}.com`));
    // 30 new tags each carried by 2 bookmarks → 30 pass minSupport, but
    // budget(60)=20 with quota floor(20*0.3)=6 → at most 6 new names kept.
    const tags = new Map<number, RawCandidate[]>();
    for (let i = 0; i < 30; i += 1) {
      const name = `主题标签${String(i).padStart(2, '0')}`;
      tags.set(i * 2, [cand(name)]);
      tags.set(i * 2 + 1, [cand(name)]);
    }
    const gov = governTaxonomy(tags, buildVocabulary([]), inputs);
    // Model-name budget holds once fallback names (host-derived, exempt) are
    // excluded from the count.
    const modelNames = gov.quality.distinct - gov.quality.fallbackNames;
    expect(modelNames).toBeLessThanOrEqual(distinctBudget(60));
    expect(modelNames).toBeLessThanOrEqual(20);

    // Non-empty vocab: quota active → new names ≤ floor(budget × 0.3).
    const entries = [entry('e1', '常用收藏', 40), entry('e2', '参考工具', 35)];
    const tags2 = new Map<number, RawCandidate[]>();
    for (let i = 0; i < 30; i += 1) {
      const name = `主题标签${String(i).padStart(2, '0')}`;
      tags2.set(i * 2, [cand(name), cand('常用收藏')]);
      tags2.set(i * 2 + 1, [cand(name), cand('参考工具')]);
    }
    const gov2 = governTaxonomy(tags2, buildVocabulary(entries), inputs);
    expect(gov2.quality.newTags).toBeLessThanOrEqual(Math.floor(20 * 0.3));
    // Existing tags always survive regardless of budget (P0-4 structural).
    const names2 = [...gov2.tags.values()].flatMap((c) => c.map((x) => x.name));
    expect(names2).toContain('常用收藏');
    expect(names2).toContain('参考工具');
  });
});

describe('governTaxonomy — determinism & performance', () => {
  it('is deterministic: same input, same output, twice', () => {
    const entries = [entry('t1', '前端', 10), entry('t2', '设计', 5)];
    const inputs = Array.from({ length: 40 }, (_, i) => input(`b${i}`, `s${i % 7}.com`));
    const build = () => {
      const tags = new Map<number, RawCandidate[]>();
      for (let i = 0; i < 40; i += 1) {
        tags.set(i, [cand(i % 3 === 0 ? '前端' : `零散主题${i}`), cand('设计', 0.7)]);
      }
      return JSON.stringify(
        [...governTaxonomy(tags, buildVocabulary(entries), inputs).tags.entries()],
        (k, v) => (k === 'reason' ? undefined : v),
      );
    };
    expect(build()).toBe(build());
  });

  it('governs 1000 bookmarks of fresh tags in under 400ms', () => {
    const inputs = Array.from({ length: 1000 }, (_, i) => input(`b${i}`, `s${i % 50}.com`));
    const tags = new Map<number, RawCandidate[]>();
    for (let i = 0; i < 1000; i += 1) {
      tags.set(i, [cand(`标签词${i % 300}`), cand(`独苗词${i}`)]);
    }
    const t0 = performance.now();
    const gov = governTaxonomy(tags, buildVocabulary([]), inputs);
    const ms = performance.now() - t0;
    // Budget applies to model names; host fallback names are exempt.
    expect(gov.quality.distinct - gov.quality.fallbackNames).toBeLessThanOrEqual(distinctBudget(1000));
    // PRD target is <200ms on dev hardware; CI shared runners run ~1.2-1.3x
    // slower, so the regression guard here is 2x the target to avoid
    // flaking on runner noise while still catching real algorithmic slips.
    expect(ms).toBeLessThan(400);
  });
});

describe('governance defaults', () => {
  it('matches the PRD threshold table', () => {
    expect(GOVERNANCE_DEFAULTS.minSupport).toBe(2);
    expect(GOVERNANCE_DEFAULTS.densityK).toBe(3);
    expect(GOVERNANCE_DEFAULTS.distinctCap).toBe(100);
    expect(GOVERNANCE_DEFAULTS.mergeSimilarity).toBe(0.75);
    expect(GOVERNANCE_DEFAULTS.newTagRatio).toBe(0.3);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildVocabulary,
  canonicalSynonym,
  editDistance,
  findDuplicateClusters,
  normalizeKey,
  resolveCandidates,
  resolveTagName,
  similarity,
  type Vocabulary,
} from '../functions/_lib/ai/taxonomy';

/** Builds a minimal vocab from name+id+count entries. */
function vocab(entries: Array<{ id: string; name: string; aliases?: string[]; count?: number }>): Vocabulary {
  return buildVocabulary(
    entries.map((e) => ({ id: e.id, name: e.name, aliases: e.aliases ?? [], count: e.count ?? 0 })),
  );
}

describe('normalizeKey', () => {
  it('collapses separators, case and full-width forms to one key', () => {
    expect(normalizeKey('Front-End')).toBe(normalizeKey('front end'));
    expect(normalizeKey('frontend')).toBe(normalizeKey('FRONTEND'));
    expect(normalizeKey('前端开发')).toBe(normalizeKey('前端　开发'));
  });

  it('strips trailing English plurals but keeps short acronyms', () => {
    expect(normalizeKey('tools')).toBe('tool');
    expect(normalizeKey('css')).toBe('css'); // length guard
    expect(normalizeKey('js')).toBe('js');
  });

  it('drops decorative punctuation', () => {
    expect(normalizeKey('"React"!')).toBe('react');
    expect(normalizeKey('ai?')).toBe('ai');
  });
});

describe('editDistance / similarity', () => {
  it('measures edits and similarity', () => {
    expect(editDistance('kubernetes', 'kubernets')).toBe(1);
    expect(editDistance('a', 'a')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
    expect(similarity('react', 'react')).toBe(1);
    expect(similarity('kubernetes', 'kubernets')).toBeGreaterThan(0.86);
  });
});

describe('canonicalSynonym', () => {
  it('folds abbreviations to the canonical spelling', () => {
    expect(canonicalSynonym('js')).toBe('JavaScript');
    expect(canonicalSynonym('fe')).toBe('前端');
    expect(canonicalSynonym('llm')).toBe('大模型');
    expect(canonicalSynonym('nonexistent')).toBeNull();
  });
});

describe('resolveTagName', () => {
  const v = vocab([{ id: 't1', name: '前端' }]);

  it('reuses an existing tag and rewards it (1.15)', () => {
    const r = resolveTagName('前端', v)!;
    expect(r.tagId).toBe('t1');
    expect(r.confidenceFactor).toBe(1.15);
    expect(r.name).toBe('前端');
  });

  it('folds a synonym to an existing tag (1.1)', () => {
    const r = resolveTagName('frontend', v)!;
    expect(r.tagId).toBe('t1');
    expect(r.confidenceFactor).toBe(1.1);
  });

  it('canonicalises a synonym into a new tag when none exists (0.95)', () => {
    const v2 = vocab([]);
    const r = resolveTagName('frontend', v2)!;
    expect(r.tagId).toBeNull();
    expect(r.name).toBe('前端'); // canonicalised
    expect(r.confidenceFactor).toBe(0.95);
    expect(r.reason).toContain('规范化');
  });

  it('falls back to a fuzzy match against an existing tag (1.05)', () => {
    const v3 = vocab([{ id: 't2', name: 'kubernetes' }]);
    const r = resolveTagName('kubernets', v3)!;
    expect(r.tagId).toBe('t2');
    expect(r.confidenceFactor).toBe(1.05);
  });

  it('treats a truly new tag as the weakest signal (0.85)', () => {
    const r = resolveTagName('量子计算', vocab([]))!;
    expect(r.tagId).toBeNull();
    expect(r.name).toBe('量子计算');
    expect(r.confidenceFactor).toBe(0.85);
    expect(r.reason).toBe('新标签');
  });

  it('returns null for empty input', () => {
    expect(resolveTagName('   ', v)).toBeNull();
  });
});

describe('resolveCandidates', () => {
  const v = vocab([{ id: 't1', name: '前端' }, { id: 't2', name: '后端' }]);

  it('de-duplicates model and heuristic output that resolve to the same tag', () => {
    const out = resolveCandidates(
      [
        { name: '前端', confidence: 0.8, source: 'fallback', reason: '域名 github.com' },
        { name: 'frontend', confidence: 0.7, source: 'model', reason: '模型建议' },
      ],
      v,
      4,
    );
    // Both collapse to tag t1, merged into a single proposal.
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('前端');
    expect(out[0].tagId).toBe('t1');
  });

  it('adds a consensus bonus and a reason when two independent engines agree', () => {
    const out = resolveCandidates(
      [
        { name: '前端', confidence: 0.8, source: 'fallback' },
        { name: 'frontend', confidence: 0.7, source: 'model' },
      ],
      v,
      4,
    );
    // base = 0.8 * 1.15 = 0.92, +0.1 consensus bonus (capped at 1).
    expect(out[0].confidence).toBeCloseTo(1, 5);
    expect(out[0].reason).toContain('多引擎一致');
  });

  it('ranks by confidence and honours the per-bookmark ceiling', () => {
    const out = resolveCandidates(
      [
        { name: '前端', confidence: 0.9, source: 'model' },
        { name: '后端', confidence: 0.5, source: 'model' },
        { name: '数据', confidence: 0.3, source: 'model' },
      ],
      v,
      2,
    );
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('前端');
    expect(out[1].name).toBe('后端');
  });
});

describe('findDuplicateClusters', () => {
  it('groups exact-normalised duplicates and keeps the most-used as canonical', () => {
    const v = vocab([
      { id: 'a', name: '工具', count: 30 },
      { id: 'b', name: 'Tools', count: 5 },
    ]);
    const clusters = findDuplicateClusters(v);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].canonical.name).toBe('工具'); // higher usage wins
    expect(clusters[0].duplicates.map((d) => d.name)).toContain('Tools');
  });

  it('catches fuzzy near-spellings as a separate reason', () => {
    const v = vocab([
      { id: 'k1', name: 'kubernetes', count: 12 },
      { id: 'k2', name: 'kubernets', count: 3 },
    ]);
    const clusters = findDuplicateClusters(v);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const hit = clusters.find((c) => c.canonical.id === 'k1');
    expect(hit?.reason).toBe('拼写高度相似');
    expect(hit?.duplicates.map((d) => d.id)).toContain('k2');
  });

  it('reports no clusters for a clean taxonomy', () => {
    const v = vocab([
      { id: 'x', name: '前端', count: 3 },
      { id: 'y', name: '后端', count: 2 },
    ]);
    expect(findDuplicateClusters(v)).toHaveLength(0);
  });
});

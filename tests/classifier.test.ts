import { describe, expect, it } from 'vitest';
import {
  buildClassificationModel,
  classifyBatch,
  classifyBookmark,
  extractFeatures,
  DEFAULT_CLASSIFY_OPTIONS,
} from '../functions/_lib/ai/classifier';
import { CLASSIFICATION_TAXONOMY, flattenTaxonomy, matchesSafety } from '../functions/_lib/ai/taxonomy-ml';
import type { BookmarkClassInput } from '../shared/types';

const bm = (
  id: string,
  title: string,
  url = '',
  description: string | null = null,
  tags: string[] = [],
): BookmarkClassInput => ({ id, title, url, description, tags });

describe('taxonomy-ml — 三级层级结构', () => {
  it('exposes 13 一级大类', () => {
    expect(CLASSIFICATION_TAXONOMY).toHaveLength(13);
    expect(CLASSIFICATION_TAXONOMY.map((c) => c.name)).toContain('开发技术');
    expect(CLASSIFICATION_TAXONOMY.map((c) => c.name)).toContain('人工智能');
  });

  it('every 一级大类 has at least one 二级子类', () => {
    for (const cat of CLASSIFICATION_TAXONOMY) {
      expect(cat.subcategories.length).toBeGreaterThan(0);
    }
  });

  it('flattenTaxonomy yields category/subcategory pairs (the model classes)', () => {
    const flat = flattenTaxonomy();
    expect(flat.length).toBeGreaterThan(13);
    expect(flat[0]).toHaveProperty('category');
    expect(flat[0]).toHaveProperty('subcategory');
  });
});

describe('extractFeatures — tokenisation', () => {
  it('extracts Latin words and CJK 1–3 grams', () => {
    const feats = extractFeatures('React 教程');
    expect(feats).toContain('react');
    expect(feats).toContain('教程'); // 2-gram / 2-char word
    expect(feats).toContain('教');
  });

  it('returns empty for blank text', () => {
    expect(extractFeatures('   ')).toEqual([]);
  });
});

describe('classifyBookmark — 三级分类正确性', () => {
  const model = buildClassificationModel();

  it('files a React frontend page into 开发技术 > 前端开发', () => {
    const p = classifyBookmark(model, bm('1', 'React 前端框架与组件开发', 'https://react.dev'));
    expect(p.category).toBe('开发技术');
    expect(p.subcategory).toBe('前端开发');
    expect(p.needsReview).toBe(false);
    expect(p.quarantined).toBe(false);
  });

  it('files an LLM page into 人工智能 > 大模型', () => {
    const p = classifyBookmark(model, bm('2', 'ChatGPT 大模型提示词工程', 'https://openai.com/blog'));
    expect(p.category).toBe('人工智能');
    expect(p.subcategory).toBe('大模型');
  });

  it('files Docker content into 运维与云 > 容器编排', () => {
    const p = classifyBookmark(model, bm('3', 'Kubernetes 与 Docker 容器编排实战', 'https://k8s.io'));
    expect(p.category).toBe('运维与云');
    expect(p.subcategory).toBe('容器编排');
  });

  it('recovers the 三级 leaf from an existing matching tag', () => {
    const p = classifyBookmark(model, bm('4', 'Vue 前端开发指南', 'https://vuejs.org', null, ['Vue']));
    expect(p.suggestedTag).toBe('Vue');
  });

  it('falls back to the subcategory name when no tag matches', () => {
    const p = classifyBookmark(model, bm('5', 'PostgreSQL 数据库优化', 'https://postgres.dev'));
    expect(p.subcategory).toBe('数据与存储');
    expect(p.suggestedTag).toBe('数据与存储');
  });
});

describe('classifyBookmark — 置信度阈值约束', () => {
  const model = buildClassificationModel();

  it('sends a zero-signal bookmark to needsReview (no category)', () => {
    const p = classifyBookmark(model, bm('x', 'hhjjkk 随机字符串 qwerty', 'https://example.com/abc'));
    expect(p.needsReview).toBe(true);
    expect(p.category).toBeNull();
    expect(p.subcategory).toBeNull();
    expect(p.reason).toContain('置信度');
  });

  it('respects a custom confidence threshold', () => {
    const opts = { ...DEFAULT_CLASSIFY_OPTIONS, confidenceThreshold: 0.95 };
    const p = classifyBookmark(model, bm('y', 'React 前端教程', 'https://react.dev'), opts);
    // Even a decent match may fall below a very high threshold.
    if (p.confidence < 0.95) {
      expect(p.needsReview).toBe(true);
      expect(p.category).toBeNull();
    } else {
      expect(p.needsReview).toBe(false);
    }
  });

  it('a strongly-matching bookmark clears the default 0.6 threshold', () => {
    const p = classifyBookmark(model, bm('z', 'React Vue 前端开发 CSS 教程', 'https://frontend.dev/docs'));
    expect(p.confidence).toBeGreaterThanOrEqual(DEFAULT_CLASSIFY_OPTIONS.confidenceThreshold);
    expect(p.needsReview).toBe(false);
  });
});

describe('classifyBookmark — 内容安全隔离', () => {
  const model = buildClassificationModel();

  it('quarantines adult/NSFW content and never files it', () => {
    const p = classifyBookmark(model, bm('a', '某成人视频站点', 'https://example.com/xxx'));
    expect(p.quarantined).toBe(true);
    expect(p.needsReview).toBe(true);
    expect(p.category).toBeNull();
    expect(p.subcategory).toBeNull();
    expect(p.quarantineReason).toContain('内容安全');
  });

  it('matchesSafety detects safety lexicon hits', () => {
    expect(matchesSafety('这是一篇关于 adult 内容的文章')).toBe(true);
    expect(matchesSafety('React 前端教程')).toBe(false);
  });
});

describe('classifyBatch — 批量稳定性与聚合', () => {
  const model = buildClassificationModel();

  it('is deterministic: identical input yields identical output', () => {
    const inputs = [
      bm('1', 'React 前端开发教程', 'https://react.dev'),
      bm('2', 'Kubernetes Docker 容器编排', 'https://k8s.io'),
      bm('3', '随机字符串 zzxq', 'https://example.com'),
    ];
    const a = classifyBatch(inputs);
    const b = classifyBatch(inputs);
    expect(JSON.stringify(a.predictions)).toEqual(JSON.stringify(b.predictions));
    expect(a.byCategory).toEqual(b.byCategory);
  });

  it('preserves input order in predictions', () => {
    const inputs = [
      bm('1', 'React 前端', 'https://react.dev'),
      bm('2', 'Docker 容器', 'https://docker.com'),
      bm('9', '成人视频', 'https://x.com/xxx'),
    ];
    const r = classifyBatch(inputs);
    expect(r.predictions.map((p) => p.bookmarkId)).toEqual(['1', '2', '9']);
  });

  it('produces correct aggregate counts', () => {
    const inputs = [
      bm('1', 'React 前端教程', 'https://react.dev'),
      bm('2', 'Docker 容器编排', 'https://k8s.io'),
      bm('3', '随机字符串 zzxq', 'https://example.com'),
      bm('4', '成人视频', 'https://x.com/xxx'),
    ];
    const r = classifyBatch(inputs);
    expect(r.total).toBe(4);
    expect(r.classified).toBe(2); // 1, 2 filed
    expect(r.needsReview).toBe(2); // 3 (zero-signal) + 4 (quarantined, also needs review)
    expect(r.quarantined).toBe(1); // 4
    expect(r.byCategory['开发技术']).toBe(1);
    expect(r.byCategory['运维与云']).toBe(1);
    // histogram bands sum to total
    const histSum = r.confidenceHistogram.reduce((s, b) => s + b.count, 0);
    expect(histSum).toBe(4);
  });

  it('softmax produces a calibrated top probability in [0,1]', () => {
    const r = classifyBatch([bm('1', 'React 前端开发 CSS 教程', 'https://react.dev')]);
    const p = r.predictions[0];
    expect(p.confidence).toBeGreaterThanOrEqual(0);
    expect(p.confidence).toBeLessThanOrEqual(1);
  });
});

describe('model training — sanity', () => {
  it('builds a model with one class per taxonomy subcategory and a vocabulary', () => {
    const model = buildClassificationModel();
    expect(model.classes.length).toBe(flattenTaxonomy().length);
    expect(model.vocab.size).toBeGreaterThan(0);
    for (const c of model.classes) {
      expect(c.logLik.size).toBe(model.vocab.size);
    }
  });
});

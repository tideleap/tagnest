import { describe, expect, it } from 'vitest';
import {
  effectiveEnrichBudgetMs,
  extractExcerptFromHtml,
  isFetchable,
  renderExcerpt,
} from '../functions/_lib/ai/enrich';
import {
  buildCoarsePrompt,
  buildTaggingPrompt,
  parseCoarseResponse,
  selectVocabularyHierarchical,
} from '../functions/_lib/ai/prompt';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';
import type { EnrichInput, Vocabulary } from '../functions/_lib/ai/types';

/* ------------------------------------------------------------------ *
 * 方案A — page-content enrichment
 * ------------------------------------------------------------------ */

describe('isFetchable', () => {
  it('accepts http/https only', () => {
    expect(isFetchable('https://example.com/a')).toBe(true);
    expect(isFetchable('http://example.com')).toBe(true);
    expect(isFetchable('chrome://settings')).toBe(false);
    expect(isFetchable('not a url')).toBe(false);
  });
});

describe('extractExcerptFromHtml', () => {
  const html = `<!DOCTYPE html><html><head>
    <title>React 官方文档</title>
    <meta name="description" content="学习 React 的组件化思维">
    <script>var x = 1;</script>
    <style>.a{color:red}</style>
  </head><body>
    <nav>首页 关于</nav>
    <article>React 是一个用于构建用户界面的 JavaScript 库。它采用声明式编程范式，让组件复用变得简单。</article>
  </body></html>`;

  it('extracts title, meta description and visible body text', () => {
    const excerpt = extractExcerptFromHtml(html);
    expect(excerpt).not.toBeNull();
    expect(excerpt!.pageTitle).toBe('React 官方文档');
    expect(excerpt!.metaDescription).toBe('学习 React 的组件化思维');
    expect(excerpt!.text).toContain('JavaScript 库');
    // Script/style content must not leak into the excerpt.
    expect(excerpt!.text).not.toContain('var x');
    expect(excerpt!.text).not.toContain('color:red');
  });

  it('prefers the article/main content when present', () => {
    const excerpt = extractExcerptFromHtml(html);
    // The nav text is outside the article and should be dropped.
    expect(excerpt!.text).not.toContain('首页 关于');
  });

  it('decodes HTML entities', () => {
    const excerpt = extractExcerptFromHtml(
      '<html><body><p>Tom &amp; Jerry &#60;3 &quot;quotes&quot;</p></body></html>',
    );
    expect(excerpt!.text).toContain('Tom & Jerry');
  });

  it('returns null for empty or non-string input', () => {
    expect(extractExcerptFromHtml('')).toBeNull();
    expect(extractExcerptFromHtml(null as unknown as string)).toBeNull();
  });
});

describe('renderExcerpt', () => {
  it('leads with the meta description when it adds information', () => {
    const rendered = renderExcerpt({
      text: '正文内容从这里开始',
      metaDescription: '编辑写的摘要',
      pageTitle: null,
    });
    expect(rendered).toMatch(/^编辑写的摘要/);
  });

  it('returns null when nothing is available', () => {
    expect(renderExcerpt({ text: '', metaDescription: null, pageTitle: null })).toBeNull();
  });
});

describe('effectiveEnrichBudgetMs — model time floor (预算挤压修复)', () => {
  it('caps fetching at partition budget minus the 15s model floor', () => {
    // A 22s partition − 15s floor = 7s fetch cap (below the flat 8s default).
    expect(effectiveEnrichBudgetMs(22000)).toBe(7000);
  });

  it('restores the flat 8s fetch cap at the 25s default partition budget', () => {
    // 25s partition − 15s floor = 10s headroom ≥ the flat 8s cap, so fetching
    // keeps its full 8s and the model still gets ≥ 15s (25 − 8 = 17s).
    expect(effectiveEnrichBudgetMs(25000)).toBe(8000);
  });

  it('falls back to the flat 8s budget when no partition budget is passed', () => {
    expect(effectiveEnrichBudgetMs(undefined)).toBe(8000);
  });

  it('collapses to zero when the partition budget equals the model floor', () => {
    // Nothing left for fetching — the model keeps its entire 15s.
    expect(effectiveEnrichBudgetMs(15000)).toBe(0);
  });

  it('never exceeds the flat 8s budget for generous partitions', () => {
    expect(effectiveEnrichBudgetMs(30000)).toBe(8000);
  });
});

/* ------------------------------------------------------------------ *
 * 方案C/D — hierarchical, relevance-weighted vocabulary
 * ------------------------------------------------------------------ */

describe('selectVocabularyHierarchical', () => {
  const vocab: Vocabulary = buildVocabulary([
    { id: 'fe', name: '前端', aliases: [], count: 12, parentId: null },
    { id: 'react', name: 'React', aliases: [], count: 8, parentId: 'fe' },
    { id: 'vue', name: 'Vue', aliases: [], count: 3, parentId: 'fe' },
    { id: 'be', name: '后端', aliases: [], count: 5, parentId: null },
  ]);

  it('nests children under their parent with a > separator', () => {
    const lines = selectVocabularyHierarchical(vocab);
    const feLine = lines.find((l) => l.startsWith('前端'));
    expect(feLine).toBeDefined();
    expect(feLine).toContain('>');
    expect(feLine).toContain('React');
    expect(feLine).toContain('Vue');
  });

  it('keeps parent-less tags as standalone lines', () => {
    const lines = selectVocabularyHierarchical(vocab);
    expect(lines.some((l) => l.startsWith('后端'))).toBe(true);
  });

  it('promotes children whose parent is missing from the set', () => {
    const orphan: Vocabulary = buildVocabulary([
      { id: 'react', name: 'React', aliases: [], count: 8, parentId: 'gone' },
    ]);
    const lines = selectVocabularyHierarchical(orphan);
    expect(lines).toContain('React(8)');
  });

  it('boosts tags matching the batch hosts (方案D)', () => {
    const big: Vocabulary = buildVocabulary([
      { id: 'a', name: 'github', aliases: [], count: 1, parentId: null },
      { id: 'b', name: '烹饪', aliases: [], count: 50, parentId: null },
      { id: 'c', name: '旅行', aliases: [], count: 40, parentId: null },
    ]);
    // Limit 1 forces a choice; the host-matching tag should win despite low count.
    const lines = selectVocabularyHierarchical(big, 1, ['github.com']);
    expect(lines[0]).toContain('github');
  });

  it('returns an empty list for an empty vocabulary', () => {
    expect(selectVocabularyHierarchical(buildVocabulary([]))).toEqual([]);
  });
});

describe('buildTaggingPrompt — enrichment & hierarchy integration', () => {
  const vocab: Vocabulary = buildVocabulary([
    { id: 'fe', name: '前端', aliases: [], count: 12, parentId: null },
    { id: 'react', name: 'React', aliases: [], count: 8, parentId: 'fe' },
  ]);

  it('renders the page excerpt when present (方案A)', () => {
    const input: EnrichInput = {
      url: 'https://react.dev/learn',
      title: 'React 文档',
      pageExcerpt: 'React 是一个声明式的 JavaScript 界面库',
    };
    const prompt = buildTaggingPrompt([input], vocab, { maxTags: 4, wantSummary: false });
    expect(prompt).toContain('正文摘要');
    expect(prompt).toContain('声明式的 JavaScript 界面库');
  });

  it('omits the excerpt line when absent', () => {
    const input: EnrichInput = { url: 'https://react.dev', title: 'React' };
    const prompt = buildTaggingPrompt([input], vocab, { maxTags: 4, wantSummary: false });
    expect(prompt).not.toContain('正文摘要');
  });

  it('renders the vocabulary hierarchically (方案C)', () => {
    const input: EnrichInput = { url: 'https://react.dev', title: 'React' };
    const prompt = buildTaggingPrompt([input], vocab, { maxTags: 4, wantSummary: false });
    expect(prompt).toContain('前端(12) > React(8)');
  });

  it('anchors the fine pass to coarse topics when provided (方案E)', () => {
    const input: EnrichInput = { url: 'https://react.dev', title: 'React' };
    const prompt = buildTaggingPrompt([input], vocab, {
      maxTags: 4,
      wantSummary: false,
      coarseTopics: ['前端框架'],
    });
    expect(prompt).toContain('初步主题判断');
    expect(prompt).toContain('前端框架');
  });
});

/* ------------------------------------------------------------------ *
 * 方案E — coarse pass parsing
 * ------------------------------------------------------------------ */

describe('buildCoarsePrompt / parseCoarseResponse', () => {
  it('asks only for a topic judgement per bookmark', () => {
    const prompt = buildCoarsePrompt([
      { url: 'https://a.dev', title: 'A' },
      { url: 'https://b.dev', title: 'B' },
    ]);
    expect(prompt).toContain('主题领域');
    // The coarse pass must not request tags or summaries — only a topic.
    expect(prompt).toContain('只输出主题判断');
    expect(prompt).not.toContain('"tags"');
    expect(prompt).not.toContain('summary');
  });

  it('parses topics aligned to the batch', () => {
    const raw = JSON.stringify({
      results: [
        { i: 1, topic: '前端框架' },
        { i: 2, topic: '运维工具' },
      ],
    });
    expect(parseCoarseResponse(raw, 2)).toEqual(['前端框架', '运维工具']);
  });

  it('fills null for missing or malformed entries and never throws', () => {
    expect(parseCoarseResponse(null, 2)).toEqual([null, null]);
    expect(parseCoarseResponse('garbage', 2)).toEqual([null, null]);
    expect(parseCoarseResponse(JSON.stringify({ results: [{ i: 1, topic: 'x' }] }), 3)).toEqual([
      'x',
      null,
      null,
    ]);
  });
});

// tests/export-format.test.ts
//
// Structural conformance of the Netscape Bookmark export. The reference desktop
// template (E:/Desktop/bookmarks_2026_8_29.html) expects a 书签栏 envelope with
// PERSONAL_TOOLBAR_FOLDER, a session layer, category folders no deeper than 3
// levels, no duplicate <H3> headers, and every bookmark emitted exactly once.
//
// `assertExportShape` locks those invariants so a refactor can't silently drift
// the output shape (fixes F5 and backs the "depth = 3" decision).

import { describe, expect, it } from 'vitest';
import { toNetscapeBookmarksHtml, type ExportRow } from '../src/lib/category-export';

function row(p: Partial<ExportRow>): ExportRow {
  return {
    bookmarkId: p.bookmarkId ?? 'b1',
    url: p.url ?? 'https://example.com',
    title: p.title ?? 'Example',
    categoryPath: p.categoryPath ?? null,
    createdAt: p.createdAt,
  };
}

interface ShapeResult {
  maxDepth: number;
  folderCount: number;
  /** H3 depth minus the 书签栏 + session wrappers (2). */
  categoryDepth: number;
}

/**
 * Validates the structural invariants of an exported bookmark HTML string.
 * Throws on the first violation; returns a summary on success.
 */
function assertExportShape(html: string): ShapeResult {
  const lines = html.split(/\r?\n/);
  const folderRe = /^(\s*)<DT><H3[^>]*>([^<]*)<\/H3>/;
  const stack: { indent: number; depth: number }[] = [];
  const seenPaths = new Set<string>();
  let maxDepth = 0;

  for (const line of lines) {
    const m = folderRe.exec(line);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    const name = m[2];
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const depth = stack.length === 0 ? 1 : stack[stack.length - 1].depth + 1;
    stack.push({ indent, depth });
    const path = stack.map((s) => s.depth).join('/') + ':' + name;
    if (seenPaths.has(path)) {
      throw new Error(`duplicate <H3> folder header: ${path}`);
    }
    seenPaths.add(path);
    maxDepth = Math.max(maxDepth, depth);
  }

  // Each bookmark anchor must appear exactly once (no duplicate emission).
  const anchors = [...html.matchAll(/<A HREF="[^"]*"[^>]*>[^<]*<\/A>/g)].map((x) => x[0]);
  const counts: Record<string, number> = {};
  for (const a of anchors) counts[a] = (counts[a] ?? 0) + 1;
  for (const [a, c] of Object.entries(counts)) {
    if (c !== 1) throw new Error(`bookmark appears ${c} times: ${a.slice(0, 48)}`);
  }

  // Wrapper / envelope invariants.
  if (!html.includes('PERSONAL_TOOLBAR_FOLDER="true"')) {
    throw new Error('书签栏 header missing PERSONAL_TOOLBAR_FOLDER="true"');
  }
  if (!html.includes('书签栏')) throw new Error('missing 书签栏 wrapper');
  if (!html.includes('✨ AI 整理')) throw new Error('missing session layer');

  // Category depth = full H3 depth minus the 书签栏 + session wrappers (2).
  const categoryDepth = maxDepth - 2;
  if (categoryDepth > 3) {
    throw new Error(`category depth ${categoryDepth} exceeds the decided 3 levels`);
  }

  return { maxDepth, folderCount: seenPaths.size, categoryDepth };
}

describe('assertExportShape — structural conformance', () => {
  it('accepts a 3-level export (领域 › 子类别 › 站点)', () => {
    const html = toNetscapeBookmarksHtml(
      [
        row({ bookmarkId: 'a', url: 'https://a.com/1', title: 'A1', categoryPath: ['开发', '前端', 'React'] }),
        row({ bookmarkId: 'b', url: 'https://a.com/2', title: 'A2', categoryPath: ['开发', '前端', 'React'] }),
        row({ bookmarkId: 'c', url: 'https://a.com/3', title: 'B1', categoryPath: ['开发', '后端', 'Go'] }),
      ],
      { generatedAt: 1_700_000_000 },
    );
    const shape = assertExportShape(html);
    expect(shape.categoryDepth).toBe(3);
    expect(html).toContain('>开发</H3>');
    expect(html).toContain('>前端</H3>');
    expect(html).toContain('>React</H3>');
    expect(html).toContain('>Go</H3>');
  });

  it('clamps a deeper-than-3 path back to 3 levels', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ bookmarkId: 'x', url: 'https://a.com/9', title: 'X', categoryPath: ['A', 'B', 'C', 'D', 'E'] })],
      { generatedAt: 1_700_000_000 },
    );
    const shape = assertExportShape(html);
    expect(shape.categoryDepth).toBe(3);
  });

  it('emits each bookmark exactly once (no duplicate anchors)', () => {
    const html = toNetscapeBookmarksHtml(
      [
        row({ bookmarkId: 'a', url: 'https://a.com/1', title: 'A1', categoryPath: ['开发', '前端'] }),
        row({ bookmarkId: 'b', url: 'https://a.com/2', title: 'A2', categoryPath: ['开发', '前端'] }),
      ],
      { generatedAt: 1_700_000_000 },
    );
    const anchors = [...html.matchAll(/<A HREF="[^"]*"[^>]*>[^<]*<\/A>/g)].map((x) => x[0]);
    expect(anchors).toHaveLength(2);
    expect(() => assertExportShape(html)).not.toThrow();
  });

  it('flags a duplicate <H3> header when the same path is emitted twice', () => {
    const dup = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<DL><p>',
      '    <DT><H3 ADD_DATE="1" LAST_MODIFIED="1" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>',
      '    <DL><p>',
      '        <DT><H3 ADD_DATE="1" LAST_MODIFIED="1">✨ AI 整理 2026/8/23 13:35:35</H3>',
      '        <DL><p>',
      '            <DT><H3 ADD_DATE="1" LAST_MODIFIED="1">开发</H3>',
      '            <DL><p>',
      '            <DT><H3 ADD_DATE="1" LAST_MODIFIED="1">开发</H3>',
      '            <DL><p>',
      '            </DL><p>',
      '            </DL><p>',
      '        </DL><p>',
      '    </DL><p>',
      '</DL><p>',
    ].join('\r\n');
    expect(() => assertExportShape(dup)).toThrow(/duplicate <H3> folder header/);
  });

  it('fails when PERSONAL_TOOLBAR_FOLDER is missing (bookmarksBar:false)', () => {
    const html = toNetscapeBookmarksHtml([], { generatedAt: 1_700_000_000, bookmarksBar: false });
    expect(() => assertExportShape(html)).toThrow();
  });

  it('round-trips a realistic mixed tree without throwing', () => {
    const html = toNetscapeBookmarksHtml(
      [
        row({ bookmarkId: 'a', url: 'https://github.com/', title: 'GitHub', categoryPath: ['开发与运维', '代码托管', 'GitHub'] }),
        row({ bookmarkId: 'b', url: 'https://amap.com/', title: '首页', categoryPath: ['开发与运维', '地图', '高德地图'] }),
        row({ bookmarkId: 'c', url: 'https://react.dev/', title: 'React 文档', categoryPath: ['开发与运维', '前端', 'React'] }),
        row({ bookmarkId: 'd', url: 'https://unknown.example/x', title: 'X', categoryPath: null }),
      ],
      { generatedAt: 1_700_000_000 },
    );
    const shape = assertExportShape(html);
    expect(shape.categoryDepth).toBeLessThanOrEqual(3);
    expect(html).toContain('首页 | 高德地图'); // friendly brand title fallback
    expect(html).toContain('首页 | GitHub');
  });
});

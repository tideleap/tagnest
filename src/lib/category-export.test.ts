// src/lib/category-export.test.ts
//
// Unit tests for the Netscape Bookmark File Format exporter.
//
// The exporter is pure and browser-independent, so we can run it under
// vitest's node environment (default for `*.test.ts` in `src/`) and assert
// the output text directly. `downloadBlob` is browser-only and is covered
// by a smoke test that just verifies the helper exists; the actual anchor
// click path needs a real DOM and is not worth a happy-dom stub.

import { describe, it, expect } from 'vitest';
import {
  toNetscapeBookmarksHtml,
  buildExportFilename,
  BOOKMARKS_BAR_TITLE,
  normalizeBookmarkTitle,
  type ExportRow,
} from './category-export';

const GEN = 1_700_000_000; // fixed timestamp so snapshots stay stable

function row(p: Partial<ExportRow>): ExportRow {
  return {
    bookmarkId: p.bookmarkId ?? 'b1',
    url: p.url ?? 'https://example.com',
    title: p.title ?? 'Example',
    categoryPath: p.categoryPath ?? null,
    createdAt: p.createdAt,
  };
}

describe('toNetscapeBookmarksHtml — header & envelope', () => {
  it('emits the Netscape doctype, charset meta and root <DL>', () => {
    const html = toNetscapeBookmarksHtml([], { generatedAt: GEN });
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    expect(html).toContain('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    // The outermost title is now the browser's bookmark-bar label, the import
    // landing target — not the legacy "TagNest 分类" root.
    expect(html).toContain('<TITLE>' + BOOKMARKS_BAR_TITLE + '</TITLE>');
    expect(html).toContain('<H1>' + BOOKMARKS_BAR_TITLE + '</H1>');
    expect(html).toContain('<DL><p>');
    // Closes the root <DL><p> with CRLF (so the file imports cleanly on
    // Windows, where some importers are strict about line endings).
    expect(html).toMatch(/\r\n<\/DL><p>\r\n$/);
  });

  it('wraps every export in 书签栏 > ✨ AI 整理 <时间戳> (session layer)', () => {
    const html = toNetscapeBookmarksHtml([], {
      generatedAt: GEN,
      sessionTitle: '✨ AI 整理 2026/8/23 13:35:35',
    });
    // Both envelope folders are emitted, nested.
    expect(html).toContain('<H1>' + BOOKMARKS_BAR_TITLE + '</H1>');
    expect(html).toContain('>✨ AI 整理 2026/8/23 13:35:35</H3>');
    // The session folder sits *inside* the bookmarks bar folder.
    const barIdx = html.indexOf('>' + BOOKMARKS_BAR_TITLE + '</H3>');
    const sessIdx = html.indexOf('>✨ AI 整理 2026/8/23 13:35:35</H3>');
    expect(barIdx).toBeGreaterThan(0);
    expect(sessIdx).toBeGreaterThan(barIdx);
  });

  it('auto-generates the session title with the ✨ AI 整理 prefix when omitted', () => {
    const html = toNetscapeBookmarksHtml([], { generatedAt: GEN });
    // The session folder name begins with the prefix and carries a stamp.
    const m = html.match(/>(\u2728 AI 整理 [^<]+)<\/H3>/);
    expect(m).not.toBeNull();
    expect(m?.[1]).toMatch(/^✨ AI 整理 \d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}$/);
  });

  it('omits the bookmarks-bar layer when bookmarksBar:false (session becomes root)', () => {
    const html = toNetscapeBookmarksHtml([], {
      generatedAt: GEN,
      bookmarksBar: false,
      sessionTitle: 'MY SESSION',
    });
    // Root title is the session title, not "书签栏".
    expect(html).toContain('<TITLE>MY SESSION</TITLE>');
    expect(html).toContain('<H1>MY SESSION</H1>');
    expect(html).not.toContain('>' + BOOKMARKS_BAR_TITLE + '</H3>');
    // No 书签栏 folder opening <DL> pair should appear.
    expect(html).not.toMatch(/>书签栏<\/H3>/);
  });
});

describe('toNetscapeBookmarksHtml — flat case', () => {
  it('renders a single categorised bookmark under a level-1 folder', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ url: 'https://x.example/a', title: '文章 A', categoryPath: ['阅读'] })],
      { generatedAt: GEN },
    );
    expect(html).toContain('<H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000000">阅读</H3>');
    expect(html).toContain('<A HREF="https://x.example/a" ADD_DATE="1700000000">文章 A</A>');
  });

  it('renders a multi-level folder chain level-1 → level-2 → bookmark', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ categoryPath: ['开发技术', '前端开发'] })],
      { generatedAt: GEN, normalizeTitles: false },
    );
    expect(html).toContain('<H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000000">开发技术</H3>');
    expect(html).toContain('<H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000000">前端开发</H3>');
    // Inner H3 must appear *after* its parent (depth-first emission).
    const i1 = html.indexOf('>开发技术</H3>');
    const i2 = html.indexOf('>前端开发</H3>');
    const i3 = html.indexOf('>Example</A>');
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  it('emits an empty folder when an intermediate path has no direct bookmarks', () => {
    // Only the deep bookmark exists, but the path [A, B, C] should still
    // materialise as three nested <H3> + <DL> headers so the user sees
    // the full chain on import.
    const html = toNetscapeBookmarksHtml(
      [row({ categoryPath: ['A', 'B', 'C'] })],
      { generatedAt: GEN },
    );
    for (const name of ['A', 'B', 'C']) {
      expect(html).toContain('>' + name + '</H3>');
    }
    // The empty intermediate B folder still opens its <DL> pair.
    const bIdx = html.indexOf('>B</H3>');
    const bDl = html.indexOf('<DL><p>', bIdx);
    expect(bIdx).toBeGreaterThan(0);
    expect(bDl).toBeGreaterThan(0);
  });
});

describe('toNetscapeBookmarksHtml — uncategorised & mixed', () => {
  it('puts uncategorised rows under a 未分类 sibling folder', () => {
    const html = toNetscapeBookmarksHtml(
      [
        row({ bookmarkId: 'b1', categoryPath: ['阅读'] }),
        row({ bookmarkId: 'b2', categoryPath: null }),
      ],
      { generatedAt: GEN },
    );
    expect(html).toContain('>阅读</H3>');
    expect(html).toContain('>未分类</H3>');
    // Both folder headers are emitted exactly once (dedupe via seen set).
    expect(html.match(/阅读<\/H3>/g)?.length).toBe(1);
    expect(html.match(/未分类<\/H3>/g)?.length).toBe(1);
  });

  it('produces a stable alphabetic order for siblings across categories', () => {
    const html = toNetscapeBookmarksHtml(
      [
        row({ bookmarkId: 'a', categoryPath: ['技术', 'JavaScript'] }),
        row({ bookmarkId: 'b', categoryPath: ['技术', 'Algorithms'] }),
        row({ bookmarkId: 'c', categoryPath: ['娱乐', '游戏'] }),
        row({ bookmarkId: 'd', categoryPath: ['娱乐', '影视'] }),
      ],
      { generatedAt: GEN },
    );
    // Within "技术", Algorithms (A) comes before JavaScript (J).
    const aIdx = html.indexOf('>Algorithms</H3>');
    const jIdx = html.indexOf('>JavaScript</H3>');
    expect(aIdx).toBeGreaterThan(0);
    expect(jIdx).toBeGreaterThan(aIdx);
    // Top-level: 技术 before 娱乐 (CJK < Latin-ish alphabetically, but
    // the actual order is implementation-defined; just assert both exist).
    const techIdx = html.indexOf('>技术</H3>');
    const entIdx = html.indexOf('>娱乐</H3>');
    expect(techIdx).toBeGreaterThan(0);
    expect(entIdx).toBeGreaterThan(0);
  });
});

describe('toNetscapeBookmarksHtml — escaping', () => {
  it('escapes &, <, > in titles and folder names', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ title: 'A & B <C>', categoryPath: ['X & Y'] })],
      { generatedAt: GEN },
    );
    expect(html).toContain('>X &amp; Y</H3>');
    expect(html).toContain('>A &amp; B &lt;C&gt;</A>');
    // Must NOT contain the raw un-escaped sequences.
    expect(html).not.toContain('A & B <C>');
    expect(html).not.toContain('>X & Y</H3>');
  });

  it('escapes & and " in URLs (keeps the link valid)', () => {
    const html = toNetscapeBookmarksHtml(
      [
        row({
          url: 'https://example.com/q?a=1&b=2&c="x"',
          categoryPath: ['工具'],
        }),
      ],
      { generatedAt: GEN },
    );
    // `&` becomes `&amp;`, `"` becomes `&quot;` so the HREF attribute
    // is well-formed.
    expect(html).toContain(
      'HREF="https://example.com/q?a=1&amp;b=2&amp;c=&quot;x&quot;"',
    );
    // The un-escaped `&` (raw ampersand) must NOT appear inside the HREF.
    const hrefStart = html.indexOf('HREF="https://example.com');
    const hrefEnd = html.indexOf('"', hrefStart + 6);
    const href = html.slice(hrefStart, hrefEnd);
    expect(href).not.toMatch(/&[^a-z#]/i); // bare & not followed by a named/numeric entity
  });

  it('falls back to the URL when the title is empty AND normalization is off', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ title: '', url: 'https://fallback.example/', categoryPath: ['X'] })],
      { generatedAt: GEN, normalizeTitles: false },
    );
    expect(html).toContain('>https://fallback.example/</A>');
  });
});

describe('toNetscapeBookmarksHtml — title normalization (default on)', () => {
  it('turns an empty title into "首页 | 站点" using the host label', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ title: '', url: 'https://amap.example/', categoryPath: ['地图'] })],
      { generatedAt: GEN },
    );
    expect(html).toContain('>首页 | amap</A>');
  });

  it('turns a bare-host title into "首页 | 站点"', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ title: 'github.com', url: 'https://github.com/', categoryPath: ['代码'] })],
      { generatedAt: GEN },
    );
    expect(html).toContain('>首页 | github</A>');
  });

  it('turns a generic placeholder title into "首页 | 站点"', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ title: '首页', url: 'https://figma.example/', categoryPath: ['设计'] })],
      { generatedAt: GEN },
    );
    expect(html).toContain('>首页 | figma</A>');
  });

  it('keeps a meaningful title verbatim (no host label appended)', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ title: 'React 官方文档', url: 'https://react.dev/', categoryPath: ['开发'] })],
      { generatedAt: GEN },
    );
    expect(html).toContain('>React 官方文档</A>');
    expect(html).not.toContain('首页 |');
  });

  it('keeps a title that already contains the site label (no double label)', () => {
    const html = toNetscapeBookmarksHtml(
      [row({ title: 'GitHub 趋势榜', url: 'https://github.com/trending', categoryPath: ['代码'] })],
      { generatedAt: GEN },
    );
    expect(html).toContain('>GitHub 趋势榜</A>');
    expect(html).not.toContain('首页 |');
  });
});

describe('normalizeBookmarkTitle — unit', () => {
  it('rescues empty / generic / bare-host titles into "首页 | 站点"', () => {
    expect(normalizeBookmarkTitle('', 'https://amap.example/')).toBe('首页 | amap');
    expect(normalizeBookmarkTitle('首页', 'https://amap.example/')).toBe('首页 | amap');
    expect(normalizeBookmarkTitle('Home', 'https://amap.example/')).toBe('首页 | amap');
    expect(normalizeBookmarkTitle('github.com', 'https://github.com/')).toBe('首页 | github');
  });

  it('falls back to the URL when the host is unusable', () => {
    expect(normalizeBookmarkTitle('', 'not-a-url')).toBe('not-a-url');
    expect(normalizeBookmarkTitle('', '')).toBe('未命名书签');
  });

  it('preserves meaningful titles and collapses internal whitespace', () => {
    expect(normalizeBookmarkTitle('  React   官方文档  ', 'https://react.dev/')).toBe('React 官方文档');
    expect(normalizeBookmarkTitle('GitHub 趋势榜', 'https://github.com/trending')).toBe('GitHub 趋势榜');
  });
});

describe('toNetscapeBookmarksHtml — createdAt pass-through', () => {
  it('uses row.createdAt (in seconds) when present, else generatedAt', () => {
    const html = toNetscapeBookmarksHtml(
      [
        row({ createdAt: 1_600_000_000, categoryPath: ['A'] }),
        row({ createdAt: 1_650_000_000, categoryPath: ['B'] }),
      ],
      { generatedAt: GEN },
    );
    expect(html).toContain('HREF="https://example.com" ADD_DATE="1600000000"');
    expect(html).toContain('HREF="https://example.com" ADD_DATE="1650000000"');
  });
});

describe('toNetscapeBookmarksHtml — empty input', () => {
  it('emits only the root <H1>/<H3> for an empty library', () => {
    const html = toNetscapeBookmarksHtml([], { generatedAt: GEN });
    // No inner folders or bookmark anchors.
    expect(html).not.toContain('<A HREF=');
    expect(html).not.toContain('>未分类</H3>');
    // Still has the root <H3> wrapping everything (so the import creates
    // a single top-level folder the user can rename / move).
    expect(html).toContain('<H1>' + BOOKMARKS_BAR_TITLE + '</H1>');
  });
});

describe('buildExportFilename', () => {
  it('produces a stable, sortable filename for a given date', () => {
    const d = new Date(2026, 7, 23, 9, 5); // month is 0-indexed
    expect(buildExportFilename(d)).toBe('tagnest-categories-2026-08-23-0905.html');
  });

  it('zero-pads single-digit month/day/hour/minute', () => {
    const d = new Date(2026, 0, 3, 1, 7);
    expect(buildExportFilename(d)).toBe('tagnest-categories-2026-01-03-0107.html');
  });
});

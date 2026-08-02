import { describe, it, expect } from 'vitest';
import {
  parseNetscapeHtml,
  parseJson,
  parseCsv,
  detectSource,
} from '../functions/_lib/import-parsers';

const NETSCAPE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000">技术</H3>
    <DL><p>
        <DT><A HREF="https://news.ycombinator.com/" ADD_DATE="1700000001">Hacker News</A>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000002">GitHub &amp; Friends</A>
        <DT><A HREF="https://vitejs.dev/guide/">Vite Guide</A>
        <DT><A HREF="place:sort=8">Recently Bookmarked</A>
    </DL><p>
    <DT><H3>阅读</H3>
    <DL><p>
        <DT><A HREF="https://www.zhihu.com/">知乎</A>
    </DL><p>
</DL><p>`;

describe('parseNetscapeHtml', () => {
  it('parses valid entries and skips invalid ones', () => {
    const { items, invalid } = parseNetscapeHtml(NETSCAPE);
    expect(items).toHaveLength(4);
    expect(invalid).toBe(1); // place:sort=8 is not a web URL
  });

  it('reconstructs the folder hierarchy as tags', () => {
    const { items } = parseNetscapeHtml(NETSCAPE);
    const tech = items.find((i) => i.url === 'https://news.ycombinator.com/');
    expect(tech?.folderPath).toEqual(['技术']);
    const zhihu = items.find((i) => i.url === 'https://www.zhihu.com/');
    expect(zhihu?.folderPath).toEqual(['阅读']);
  });

  it('decodes HTML entities in titles', () => {
    const { items } = parseNetscapeHtml(NETSCAPE);
    const github = items.find((i) => i.url === 'https://github.com/');
    expect(github?.title).toBe('GitHub & Friends');
  });

  it('reads ADD_DATE into an ISO timestamp', () => {
    const { items } = parseNetscapeHtml(NETSCAPE);
    expect(items[0].addedAt).toBe('2023-11-14T22:13:21.000Z');
  });

  it('omits the timestamp when none is present', () => {
    const { items } = parseNetscapeHtml(NETSCAPE);
    const vite = items.find((i) => i.url === 'https://vitejs.dev/guide/');
    expect(vite?.addedAt).toBeNull();
  });

  it('does not throw on an out-of-range character entity in a title', () => {
    // A malformed/oversized numeric entity (e.g. past the Unicode maximum)
    // previously crashed String.fromCodePoint and turned the whole import
    // into a 500. It must be left as-is and the other bookmarks still parse.
    const src = `<DL><p>
      <DT><A HREF="https://a.example/x">bad &#1114114; entity</A>
      <DT><A HREF="https://b.example/y">Good bookmark</A>
    </DL><p>`;
    const { items, invalid } = parseNetscapeHtml(src);
    expect(() => parseNetscapeHtml(src)).not.toThrow();
    expect(items).toHaveLength(2);
    expect(items[1].title).toBe('Good bookmark');
    expect(items[0].title).toContain('&#'); // oversized entity kept verbatim
    expect(invalid).toBe(0);
  });

  it('does not throw on a lone-surrogate numeric entity in a URL attribute', () => {
    // A high surrogate in a URL that must be decoded but is not a valid
    // Unicode scalar value must not crash the parser.
    const src = `<DL><p>
      <DT><A HREF="https://c.example/?q=&#xD800;">surrogate</A>
    </DL><p>`;
    expect(() => parseNetscapeHtml(src)).not.toThrow();
  });
});

describe('parseJson', () => {
  it('accepts a bare array', () => {
    const { items, invalid } = parseJson(
      JSON.stringify([{ url: 'https://a.com', title: 'A' }, { url: 'garbage' }]),
    );
    expect(items).toHaveLength(1);
    expect(invalid).toBe(1);
  });

  it('accepts the { bookmarks: [] } shape', () => {
    const { items } = parseJson(
      JSON.stringify({ bookmarks: [{ url: 'https://b.com', tags: ['x', 'y'] }] }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].tagNames).toEqual(['x', 'y']);
  });

  it('accepts the { items: [] } shape', () => {
    const { items } = parseJson(JSON.stringify({ items: [{ url: 'https://c.com' }] }));
    expect(items).toHaveLength(1);
  });

  it('carries folder paths from nested fields', () => {
    const { items } = parseJson(
      JSON.stringify([{ url: 'https://d.com', folder: 'Dev/Web' }]),
    );
    expect(items[0].folderPath).toEqual(['Dev', 'Web']);
  });

  it('returns nothing for unparseable input', () => {
    expect(parseJson('{not json')).toEqual({ items: [], invalid: 0 });
  });
});

describe('parseCsv', () => {
  it('honours a header row', () => {
    const { items } = parseCsv('url,title,tags\nhttps://a.com,First,x;y\nhttps://b.com,Second,');
    expect(items).toHaveLength(2);
    expect(items[0].tagNames).toEqual(['x', 'y']);
    expect(items[1].tagNames).toEqual([]);
  });

  it('falls back to positional columns when there is no url header', () => {
    const { items } = parseCsv('https://a.com,First\ngarbage line');
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://a.com/');
    expect(items[0].title).toBe('First');
  });

  it('treats invalid rows as invalid, not items', () => {
    const { items, invalid } = parseCsv('url\ngarbage\nhttps://a.com');
    expect(items).toHaveLength(1);
    expect(invalid).toBe(1);
  });
});

describe('detectSource', () => {
  it('uses the file extension', () => {
    expect(detectSource('bookmarks.html', '')).toBe('html');
    expect(detectSource('x.json', '')).toBe('json');
    expect(detectSource('x.csv', '')).toBe('csv');
  });

  it('sniffs content when the extension is missing', () => {
    expect(detectSource('', '[{"url":"https://a.com"}]')).toBe('json');
    expect(detectSource('', '<a href="https://a.com">A</a>')).toBe('html');
  });
});

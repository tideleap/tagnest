// tests/feed.test.ts
//
// Unit tests for the dependency-free RSS/Atom parser in functions/_lib/feed.ts.
// These exercise parseFeed as a pure function (XML string → items) with no D1
// or network fixture, pinning the exact behaviour we rely on for dedup and
// bookmark creation downstream.

import { describe, expect, it } from 'vitest';
import { parseFeed } from '../functions/_lib/feed';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>示例博客</title>
  <link>https://blog.example.com</link>
  <item>
    <title>第一篇文章</title>
    <link>https://blog.example.com/posts/1</link>
    <description>这是摘要</description>
    <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>第二篇文章</title>
    <link>https://blog.example.com/posts/2</link>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/atom">
  <title>Atom 源</title>
  <entry>
    <title>条目一</title>
    <link rel="alternate" type="text/html" href="https://atom.example.com/1"/>
    <link rel="self" href="https://atom.example.com/feed"/>
    <updated>2024-02-01T00:00:00Z</updated>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses an RSS 2.0 channel and its items', () => {
    const f = parseFeed(RSS);
    expect(f.title).toBe('示例博客');
    expect(f.items).toHaveLength(2);
    expect(f.items[0].url).toBe('https://blog.example.com/posts/1');
    expect(f.items[0].summary).toBe('这是摘要');
    expect(f.items[0].publishedAt).toBe('2024-01-01T10:00:00.000Z');
    // Item without a date → null, not a throw.
    expect(f.items[1].publishedAt).toBeNull();
  });

  it('parses an Atom feed and prefers the alternate (non-self) link', () => {
    const f = parseFeed(ATOM);
    expect(f.title).toBe('Atom 源');
    expect(f.items).toHaveLength(1);
    expect(f.items[0].url).toBe('https://atom.example.com/1');
    expect(f.items[0].publishedAt).toBe('2024-02-01T00:00:00.000Z');
  });

  it('decodes CDATA and HTML entities in titles and links', () => {
    const xml = `<rss version="2.0"><channel><title>T</title>
      <item>
        <title><![CDATA[技巧 & 窍门]]></title>
        <link>https://x.example.com/a&amp;b</link>
      </item>
    </channel></rss>`;
    const f = parseFeed(xml);
    expect(f.items[0].title).toBe('技巧 & 窍门');
    expect(f.items[0].url).toBe('https://x.example.com/a&b');
  });

  it('returns an empty result for blank or unparseable input', () => {
    expect(parseFeed('')).toEqual({ title: null, items: [] });
    expect(parseFeed('<html>no feed here</html>')).toEqual({ title: null, items: [] });
  });

  it('skips entries that have no link at all', () => {
    const xml = `<rss version="2.0"><channel><title>T</title>
      <item><title>没有链接</title></item>
    </channel></rss>`;
    const f = parseFeed(xml);
    expect(f.items).toHaveLength(0);
  });
});

// tests/sync-diff.test.ts
//
// Guards the contract that makes reconciliation correct: the extension's JS
// `urlKey` must produce byte-identical keys to the server's urlkey.ts
// `urlKey`, otherwise a browser bookmark and its TagNest twin would never
// match. Also covers flattenBrowserBookmarks and diffByKey.

import { describe, it, expect } from 'vitest';
import { urlKey as urlKeyJs, flattenBrowserBookmarks, diffByKey } from '../extension/bg/sync-diff.js';
import { urlKey as urlKeyTs } from '../functions/_lib/urlkey';

const CASES = [
  'https://www.Example.com/Path/?utm_source=news&z=1',
  'http://example.com/a/',
  'https://example.com/a?b=2&a=1',
  'example.com/foo',
  'https://example.com',
  'https://example.com/?utm_medium=email&ref=home',
  'not a url',
  'javascript:alert(1)',
  'file:///etc/passwd',
];

describe('urlKey parity (extension JS vs server TS)', () => {
  for (const url of CASES) {
    it(`matches for ${url}`, () => {
      expect(urlKeyJs(url)).toBe(urlKeyTs(url));
    });
  }
});

describe('flattenBrowserBookmarks', () => {
  it('flattens a tree keeping only URL leaves', () => {
    const tree = [
      {
        id: '1',
        title: 'root',
        children: [
          { id: '2', title: 'A', url: 'https://a.com' },
          { id: '3', title: 'folder', children: [{ id: '4', title: 'B', url: 'https://b.com' }] },
        ],
      },
    ];
    const flat = flattenBrowserBookmarks(tree);
    expect(flat).toHaveLength(2);
    expect(flat.map((n) => n.id).sort()).toEqual(['2', '4']);
  });
});

describe('diffByKey', () => {
  it('splits into only-in-browser, only-in-tagnest, and both', () => {
    const browser = [
      { id: 'b1', url: 'https://a.com/1' },
      { id: 'b2', url: 'https://b.com/2' },
      { id: 'b3', url: 'https://c.com/3' },
    ];
    const tn = [
      { id: 't2', urlKey: urlKeyTs('https://b.com/2'), title: 'B' },
      { id: 't3', urlKey: urlKeyTs('https://c.com/3'), title: 'C' },
      { id: 't9', urlKey: urlKeyTs('https://z.com/9'), title: 'Z' },
    ];
    const d = diffByKey(browser, tn);
    expect(d.onlyInBrowser.map((x) => x.id)).toEqual(['b1']);
    expect(d.onlyInTagNest.map((x) => x.id)).toEqual(['t9']);
    expect(d.both).toHaveLength(2);
  });

  it('treats utm noise as the same bookmark (dedupe)', () => {
    const browser = [{ id: 'b1', url: 'https://a.com/x?utm_source=news' }];
    const tn = [{ id: 't1', urlKey: urlKeyTs('https://a.com/x'), title: 'A' }];
    const d = diffByKey(browser, tn);
    expect(d.both).toHaveLength(1);
    expect(d.onlyInBrowser).toHaveLength(0);
  });
});

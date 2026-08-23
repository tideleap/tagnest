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

  it('reads folderPath null for every leaf when no managed folder is given', () => {
    const tree = [
      {
        id: '1',
        title: 'root',
        children: [{ id: '2', title: 'A', url: 'https://a.com' }],
      },
    ];
    const flat = flattenBrowserBookmarks(tree);
    expect(flat[0].folderPath).toBeNull();
  });
});

describe('flattenBrowserBookmarks — managed-folder folderPath (C4-2)', () => {
  // Browser bar
  //   ├─ loose (outside managed)
  //   └─ TagNest 分类 (managed root, id 'm')
  //        ├─ direct          → folderPath []
  //        └─ 开发技术         → folder
  //             └─ nested     → folderPath ['开发技术']
  //                  └─ deep  → folderPath ['开发技术', '前端开发']
  const tree = [
    {
      id: 'bar',
      title: '书签栏',
      children: [
        { id: 'loose', title: 'Loose', url: 'https://loose.example.com' },
        {
          id: 'm',
          title: 'TagNest 分类',
          children: [
            { id: 'direct', title: 'Direct', url: 'https://direct.example.com' },
            {
              id: 'dev',
              title: '开发技术',
              children: [
                { id: 'nested', title: 'Nested', url: 'https://nested.example.com' },
                {
                  id: 'fe',
                  title: '前端开发',
                  children: [{ id: 'deep', title: 'Deep', url: 'https://deep.example.com' }],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  it('assigns the folder path relative to the managed root, root children get []', () => {
    const flat = flattenBrowserBookmarks(tree, 'm');
    const byId = new Map(flat.map((n) => [n.id, n]));
    expect(byId.get('direct')!.folderPath).toEqual([]);
    expect(byId.get('nested')!.folderPath).toEqual(['开发技术']);
    expect(byId.get('deep')!.folderPath).toEqual(['开发技术', '前端开发']);
  });

  it('reads folderPath null for bookmarks outside the managed subtree', () => {
    const flat = flattenBrowserBookmarks(tree, 'm');
    const loose = flat.find((n) => n.id === 'loose')!;
    expect(loose.folderPath).toBeNull();
  });

  it('never includes the managed root title itself in the path', () => {
    const flat = flattenBrowserBookmarks(tree, 'm');
    for (const n of flat) {
      if (n.folderPath !== null) {
        expect(n.folderPath).not.toContain('TagNest 分类');
      }
    }
  });

  it('works when the managed folder is nested inside other folders', () => {
    // Managed root buried one level deeper — paths still start below it.
    const nestedTree = [
      {
        id: 'outer',
        title: 'outer',
        children: [
          {
            id: 'm',
            title: 'TagNest 分类',
            children: [{ id: 'x', title: 'X', url: 'https://x.example.com' }],
          },
        ],
      },
    ];
    const flat = flattenBrowserBookmarks(nestedTree, 'm');
    expect(flat).toHaveLength(1);
    expect(flat[0].folderPath).toEqual([]);
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

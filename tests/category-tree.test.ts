// tests/category-tree.test.ts
//
// Guards the CategorySync P2 planner (extension/bg/category-tree.js): the pure
// function that turns the cloud writeback feed into a folder/bookmark plan for
// the managed "TagNest" folder. Same convention as sync-diff.test.ts — the
// extension module is chrome.*-free so the backend suite imports it directly.

import { describe, it, expect } from 'vitest';
import {
  planCategoryBuild,
  serializeSubtree,
  countSubtree,
  indexManagedTree,
  normalizeManifest,
  emptyManifest,
  pathLabel,
} from '../extension/bg/category-tree.js';
import { urlKey } from '../extension/bg/sync-diff.js';

// ---------------------------------------------------------------------------
// helpers: fake chrome.bookmarks trees
// ---------------------------------------------------------------------------

let nextId = 100;
const folder = (title: string, children: unknown[] = []) => ({
  id: `n${nextId++}`,
  title,
  children,
});
const bookmark = (title: string, url: string) => ({
  id: `n${nextId++}`,
  title,
  url,
});

const feedItem = (url: string, title: string, categoryPath: string[] | null) => ({
  bookmarkId: `b-${url}`,
  url,
  title,
  categoryPath,
});

/** Collect every node id inside a managed subtree (root excluded). */
function collectIds(tree: { children?: unknown[] } | null): Set<string> {
  const ids = new Set<string>();
  const walk = (node: { id?: string; children?: unknown[] }) => {
    for (const c of (node.children || []) as { id?: string; children?: unknown[] }[]) {
      if (c.id) ids.add(c.id);
      walk(c);
    }
  };
  if (tree) walk(tree);
  return ids;
}

/** C3-7 guard: every node the plan touches must live inside the managed tree. */
function assertAllTargetsInsideManaged(plan: ReturnType<typeof planCategoryBuild>, tree: unknown) {
  const ids = collectIds(tree as { children?: unknown[] });
  for (const m of plan.moveBookmarks) expect(ids.has(m.nodeId)).toBe(true);
  for (const u of plan.updateTitles) expect(ids.has(u.nodeId)).toBe(true);
  for (const r of plan.removeNodes) expect(ids.has(r.nodeId)).toBe(true);
  // create ops carry no nodeId yet, but their paths are relative to the
  // managed root — assert they never escape it (no '..' tricks, no absolute).
  for (const f of plan.createFolders) {
    expect(f.path.every((seg) => seg.length > 0)).toBe(true);
  }
  for (const b of plan.createBookmarks) {
    expect(b.path.every((seg) => seg.length > 0)).toBe(true);
  }
}

// ---------------------------------------------------------------------------

describe('planCategoryBuild — first build', () => {
  it('creates folders parents-first and places bookmarks', () => {
    const feed = [
      feedItem('https://a.com/1', 'React 文档', ['开发技术', '前端开发']),
      feedItem('https://a.com/2', 'Node 指南', ['开发技术', '后端']),
      feedItem('https://a.com/3', '菜谱', ['生活']),
    ];
    const plan = planCategoryBuild({ feedItems: feed, managedTree: { id: 'root', title: 'TagNest', children: [] }, manifest: null });

    expect(plan.stats.foldersToCreate).toBe(4); // 开发技术, 前端开发, 后端, 生活
    expect(plan.stats.bookmarksToCreate).toBe(3);
    expect(plan.stats.bookmarksToMove).toBe(0);
    expect(plan.stats.nodesToRemove).toBe(0);
    // parents before children
    const order = plan.createFolders.map((f) => pathLabel(f.path));
    expect(order.indexOf('开发技术')).toBeLessThan(order.indexOf('开发技术 > 前端开发'));
    expect(order.indexOf('开发技术')).toBeLessThan(order.indexOf('开发技术 > 后端'));
    // manifest records ownership for the next incremental run
    expect(plan.nextManifest.bookmarks[urlKey('https://a.com/1')]).toEqual(['开发技术', '前端开发']);
    expect(plan.nextManifest.folders.map(pathLabel).sort()).toEqual(
      ['开发技术', '开发技术 > 前端开发', '开发技术 > 后端', '生活'].sort(),
    );
  });

  it('normalizes messy category paths (empty segments dropped)', () => {
    const feed = [feedItem('https://a.com/1', 'X', ['  开发技术 ', '', '前端开发'])];
    const plan = planCategoryBuild({ feedItems: feed, managedTree: { id: 'root', title: 'TagNest', children: [] }, manifest: null });
    expect(plan.createBookmarks[0].path).toEqual(['开发技术', '前端开发']);
  });

  it('skips feed rows without a usable url', () => {
    const feed = [
      { url: '', title: 'no url', categoryPath: ['A'] },
      { url: 'javascript:alert(1)', title: 'js', categoryPath: ['A'] },
      feedItem('https://ok.com', 'ok', ['A']),
    ];
    const plan = planCategoryBuild({ feedItems: feed, managedTree: { id: 'root', title: 'TagNest', children: [] }, manifest: null });
    expect(plan.stats.bookmarksToCreate).toBe(1);
  });
});

describe('planCategoryBuild — idempotence & incremental diff (C3-5)', () => {
  const feed = [
    feedItem('https://a.com/1', 'React 文档', ['开发技术', '前端开发']),
    feedItem('https://a.com/2', 'Node 指南', ['开发技术', '后端']),
  ];

  it('second run against the converged tree is a no-op', () => {
    const tree = folder('TagNest', [
      folder('开发技术', [
        folder('前端开发', [bookmark('React 文档', 'https://a.com/1')]),
        folder('后端', [bookmark('Node 指南', 'https://a.com/2')]),
      ]),
    ]);
    const first = planCategoryBuild({ feedItems: feed, managedTree: tree, manifest: null });
    // simulate: the orchestrator applied `first` and persisted nextManifest
    const second = planCategoryBuild({ feedItems: feed, managedTree: tree, manifest: first.nextManifest });
    expect(second.stats.foldersToCreate).toBe(0);
    expect(second.stats.bookmarksToCreate).toBe(0);
    expect(second.stats.bookmarksToMove).toBe(0);
    expect(second.stats.titlesToUpdate).toBe(0);
    expect(second.stats.nodesToRemove).toBe(0);
    expect(second.stats.unchanged).toBe(2);
  });

  it('category change moves the bookmark instead of recreating it', () => {
    // Realistic two-phase flow: first build on an empty managed folder
    // (ownership recorded), then the cloud re-categorizes one bookmark.
    const emptyTree = folder('TagNest', []);
    const first = planCategoryBuild({ feedItems: feed, managedTree: emptyTree, manifest: null });
    expect(first.stats.bookmarksToCreate).toBe(2);

    // The orchestrator applied `first`; this is the converged tree it produced.
    const converged = folder('TagNest', [
      folder('开发技术', [
        folder('前端开发', [bookmark('React 文档', 'https://a.com/1')]),
        folder('后端', [bookmark('Node 指南', 'https://a.com/2')]),
      ]),
    ]);
    const movedFeed = [
      feedItem('https://a.com/1', 'React 文档', ['开发技术', '后端']), // re-categorized
      feedItem('https://a.com/2', 'Node 指南', ['开发技术', '后端']),
    ];
    const second = planCategoryBuild({ feedItems: movedFeed, managedTree: converged, manifest: first.nextManifest });
    expect(second.stats.bookmarksToMove).toBe(1);
    expect(second.stats.bookmarksToCreate).toBe(0);
    expect(second.moveBookmarks[0].fromPath).toEqual(['开发技术', '前端开发']);
    expect(second.moveBookmarks[0].toPath).toEqual(['开发技术', '后端']);
    // The stale folder still holds the bookmark this round (the move hasn't
    // executed yet), so it must NOT be removed now — only next round, once it
    // is actually empty. Ownership is retained for that re-check.
    expect(second.removeNodes.length).toBe(0);
    expect(second.nextManifest.folders.map(pathLabel)).toContain('开发技术 > 前端开发');

    // Third round: the move was applied, the folder is now empty → removed.
    const afterMove = folder('TagNest', [
      folder('开发技术', [
        folder('前端开发', []),
        folder('后端', [bookmark('React 文档', 'https://a.com/1'), bookmark('Node 指南', 'https://a.com/2')]),
      ]),
    ]);
    const third = planCategoryBuild({ feedItems: movedFeed, managedTree: afterMove, manifest: second.nextManifest });
    expect(third.stats.bookmarksToMove).toBe(0);
    expect(third.removeNodes.some((r) => r.isFolder && pathLabel(r.path) === '开发技术 > 前端开发')).toBe(true);
    expect(third.nextManifest.folders.map(pathLabel)).not.toContain('开发技术 > 前端开发');
  });

  it('title drift on an owned bookmark becomes an update, not a recreate', () => {
    const tree = folder('TagNest', [folder('生活', [bookmark('旧标题', 'https://a.com/9')])]);
    const manifest = {
      version: 1,
      bookmarks: { [urlKey('https://a.com/9')]: ['生活'] },
      folders: [['生活']],
    };
    const plan = planCategoryBuild({
      feedItems: [feedItem('https://a.com/9', '新标题', ['生活'])],
      managedTree: tree,
      manifest,
    });
    expect(plan.stats.titlesToUpdate).toBe(1);
    expect(plan.stats.bookmarksToCreate).toBe(0);
    expect(plan.updateTitles[0].title).toBe('新标题');
  });
});

describe('planCategoryBuild — ownership & stale cleanup', () => {
  it('removes owned bookmarks the feed no longer contains', () => {
    const tree = folder('TagNest', [
      folder('生活', [bookmark('菜谱', 'https://a.com/3'), bookmark('旧物', 'https://a.com/old')]),
    ]);
    const manifest = {
      version: 1,
      bookmarks: { [urlKey('https://a.com/3')]: ['生活'], [urlKey('https://a.com/old')]: ['生活'] },
      folders: [['生活']],
    };
    const plan = planCategoryBuild({
      feedItems: [feedItem('https://a.com/3', '菜谱', ['生活'])],
      managedTree: tree,
      manifest,
    });
    expect(plan.stats.nodesToRemove).toBe(1);
    expect(plan.removeNodes[0].url).toBe('https://a.com/old');
    expect(plan.removeNodes[0].isFolder).toBe(false);
  });

  it('keeps a stale owned folder that still has children', () => {
    const tree = folder('TagNest', [
      folder('废弃分类', [bookmark('用户自己放的', 'https://user.com/x')]),
    ]);
    const manifest = { version: 1, bookmarks: {}, folders: [['废弃分类']] };
    const plan = planCategoryBuild({ feedItems: [], managedTree: tree, manifest });
    expect(plan.removeNodes.length).toBe(0);
    // ownership retained so we re-check next run
    expect(plan.nextManifest.folders.map(pathLabel)).toEqual(['废弃分类']);
  });

  it('never renames or moves a user node it does not own', () => {
    // User placed a bookmark at the target path themselves; the feed agrees.
    const tree = folder('TagNest', [folder('生活', [bookmark('用户标题', 'https://a.com/3')])]);
    const plan = planCategoryBuild({
      feedItems: [feedItem('https://a.com/3', '云端标题', ['生活'])],
      managedTree: tree,
      manifest: emptyManifest(),
    });
    expect(plan.stats.titlesToUpdate).toBe(0); // adopted as-is
    expect(plan.stats.bookmarksToMove).toBe(0);
    expect(plan.stats.unchanged).toBe(1);
  });

  it('moves a legacy flat copy from the managed root into its folder (A9 dedupe)', () => {
    const tree = folder('TagNest', [bookmark('React 文档', 'https://a.com/1')]);
    const plan = planCategoryBuild({
      feedItems: [feedItem('https://a.com/1', 'React 文档', ['开发技术', '前端开发'])],
      managedTree: tree,
      manifest: emptyManifest(),
    });
    expect(plan.stats.bookmarksToMove).toBe(1);
    expect(plan.stats.bookmarksToCreate).toBe(0);
    expect(plan.moveBookmarks[0].fromPath).toEqual([]);
    expect(plan.moveBookmarks[0].toPath).toEqual(['开发技术', '前端开发']);
  });
});

describe('planCategoryBuild — 托管外零写入 (C3-7)', () => {
  it('every plan target stays inside the managed subtree', () => {
    const tree = folder('TagNest', [
      folder('开发技术', [
        folder('前端开发', [bookmark('React 文档', 'https://a.com/1')]),
        bookmark('旧位置', 'https://a.com/2'),
      ]),
      bookmark('根下旧物', 'https://a.com/3'),
    ]);
    const manifest = {
      version: 1,
      bookmarks: {
        [urlKey('https://a.com/1')]: ['开发技术', '前端开发'],
        [urlKey('https://a.com/2')]: ['开发技术'],
        [urlKey('https://a.com/3')]: [],
      },
      folders: [['开发技术'], ['开发技术', '前端开发']],
    };
    const feed = [
      feedItem('https://a.com/1', 'React 文档', ['开发技术', '后端']), // move
      feedItem('https://a.com/2', '旧位置', ['生活']), // move + new folder
      feedItem('https://a.com/4', '新书签', ['生活']), // create
    ];
    const plan = planCategoryBuild({ feedItems: feed, managedTree: tree, manifest });
    assertAllTargetsInsideManaged(plan, tree);
    // the root-level stale owned bookmark is removed, still inside managed
    expect(plan.removeNodes.some((r) => r.url === 'https://a.com/3')).toBe(true);
  });

  it('missing managed folder yields a full first-build plan flagged for confirmation', () => {
    const feed = [feedItem('https://a.com/1', 'React 文档', ['开发技术'])];
    const plan = planCategoryBuild({ feedItems: feed, managedTree: null, manifest: null });
    expect(plan.managedFolderMissing).toBe(true);
    expect(plan.stats.managedFolderMissing).toBe(true);
    expect(plan.stats.bookmarksToCreate).toBe(1);
  });
});

describe('planCategoryBuild — promote mode (managed root = bookmarks bar, P6-A)', () => {
  it('plans top-level ownership and leaves a non-owned top-level user folder untouched', () => {
    const bar = folder('书签栏', [
      folder('工作', [bookmark('用户书签', 'https://user.com/x')]),
      bookmark('散落', 'https://loose.com/y'),
    ]);
    const feed = [feedItem('https://a.com/1', 'React', ['开发技术'])];
    const plan = planCategoryBuild({ feedItems: feed, managedTree: bar, manifest: null });
    expect(plan.stats.foldersToCreate).toBe(1); // 开发技术 at the top level
    expect(plan.stats.bookmarksToCreate).toBe(1);
    expect(plan.stats.nodesToRemove).toBe(0); // 工作 is not owned → untouched
    expect(plan.nextManifest.folders.map(pathLabel)).toEqual(['开发技术']);
  });

  it('reuses an existing top-level folder of the same name instead of duplicating', () => {
    const bar = folder('书签栏', [folder('开发技术', [])]);
    const feed = [feedItem('https://a.com/1', 'React', ['开发技术'])];
    const plan = planCategoryBuild({ feedItems: feed, managedTree: bar, manifest: null });
    expect(plan.stats.foldersToCreate).toBe(0); // reuse existing 开发技术
    expect(plan.stats.bookmarksToCreate).toBe(1);
  });
});

describe('serializeSubtree / countSubtree / indexManagedTree', () => {
  it('serializes a subtree without ids (rollback rebuilds from content)', () => {
    const tree = folder('TagNest', [
      folder('开发技术', [bookmark('React 文档', 'https://a.com/1')]),
    ]);
    const snap = serializeSubtree(tree);
    expect(snap).toEqual({
      title: 'TagNest',
      children: [
        { title: '开发技术', children: [{ title: 'React 文档', url: 'https://a.com/1' }] },
      ],
    });
    expect(JSON.stringify(snap)).not.toContain('n1');
  });

  it('counts folders and bookmarks', () => {
    const tree = folder('TagNest', [
      folder('A', [bookmark('x', 'https://x.com'), folder('B', [])]),
      bookmark('y', 'https://y.com'),
    ]);
    expect(countSubtree(tree)).toEqual({ folders: 2, bookmarks: 2 });
  });

  it('indexes folders by title-path and bookmarks by urlKey', () => {
    const tree = folder('TagNest', [
      folder('开发技术', [
        folder('前端开发', [bookmark('React 文档', 'https://a.com/1')]),
      ]),
    ]);
    const { foldersByLabel, bookmarksByKey } = indexManagedTree(tree);
    expect(foldersByLabel.get('开发技术 > 前端开发')?.childCount).toBe(1);
    expect(bookmarksByKey.get(urlKey('https://a.com/1'))?.[0].title).toBe('React 文档');
  });

  it('normalizeManifest tolerates garbage from storage', () => {
    const m = normalizeManifest({ bookmarks: { k: ['a', 1], bad: 'nope' }, folders: [['x'], 'nope'] });
    expect(m.bookmarks.k).toEqual(['a', '1']);
    expect(m.bookmarks.bad).toBeUndefined();
    expect(m.folders).toEqual([['x']]);
    expect(normalizeManifest(null)).toEqual(emptyManifest());
  });
});

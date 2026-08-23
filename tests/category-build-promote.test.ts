// tests/category-build-promote.test.ts
//
// P6-A "promote to bar" safety net. The category build may mirror the cloud
// tree at the bookmarks-bar root instead of under a "TagNest" subfolder. The
// dangerous case is rollback: the "managed root" becomes the WHOLE bar, so a
// whole-tree removeTree would wipe the user's bookmarks. These tests prove the
// per-op backup keeps rollback surgical — it only ever touches the nodes this
// build created/moved/removed, never the user's other bookmarks or the bar
// itself. Also covers the sync folderPath restriction (C4-2) so promote mode
// never pushes the user's unrelated top-level folders up as categories.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flattenBrowserBookmarks } from '../extension/bg/sync-diff.js';

function buildChrome() {
  const nodeById: Record<string, any> = {};
  const storage = { data: {}, get: vi.fn(), set: vi.fn(), remove: vi.fn() };
  storage.get.mockImplementation(async (keys: any) => {
    const arr = Array.isArray(keys) ? keys : [keys];
    const out: any = {};
    for (const k of arr) if (k in storage.data) out[k] = storage.data[k];
    return out;
  });
  storage.set.mockImplementation(async (obj: any) => {
    Object.assign(storage.data, obj);
  });
  storage.remove.mockImplementation(async (keys: any) => {
    for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage.data[k];
  });
  let nextId = 1000;
  const bookmarks = {
    getTree: vi.fn(),
    get: vi.fn(async (id: string) => (nodeById[id] ? [nodeById[id]] : [])),
    getChildren: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (node: any) => {
      const id = `n${nextId++}`;
      const created = { id, ...node };
      nodeById[id] = created;
      return created;
    }),
    update: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeTree: vi.fn().mockResolvedValue(undefined),
  };
  const permissions = { contains: vi.fn().mockResolvedValue(true), request: vi.fn().mockResolvedValue(true) };
  return { storage: { local: storage }, bookmarks, permissions, nodeById };
}

const cfg = (promote: boolean) => ({
  baseUrl: 'https://tagnest.pages.dev',
  apiKey: 'tnk_abc',
  promoteToBar: promote,
});

function feedFetch(items: any[]) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/category/tree')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items, nextCursor: null, total: items.length }),
      };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  });
}

// bar root is tree[0].children[0]; `top` are the top-level nodes.
function barTree(top: any[]) {
  return [{ id: '0', children: [{ id: '1', children: top }] }];
}

// ---------------------------------------------------------------------------

describe('flattenBrowserBookmarks — promote folderPath restriction (C4-2)', () => {
  it('attaches folderPath only inside owned folders when restricted', () => {
    const tree = barTree([
      { id: 'dev', title: '开发技术', children: [{ id: 'b1', url: 'https://a.com/1', title: 'React' }] },
      { id: 'work', title: '工作', children: [{ id: 'b2', url: 'https://a.com/2', title: 'X' }] },
      { id: 'b3', url: 'https://a.com/3', title: 'Loose' },
    ]);
    const flat = flattenBrowserBookmarks(tree, '1', new Set(['dev']));
    const byUrl: Record<string, any> = {};
    for (const f of flat) byUrl[f.url] = f.folderPath;
    expect(byUrl['https://a.com/1']).toEqual(['开发技术']); // inside owned
    expect(byUrl['https://a.com/2']).toBeNull(); // user folder, not owned
    expect(byUrl['https://a.com/3']).toBeNull(); // loose at bar root
  });

  it('attaches folderPath for all inside the managed root when not restricted', () => {
    const tree = barTree([{ id: 'work', title: '工作', children: [{ id: 'b2', url: 'https://a.com/2', title: 'X' }] }]);
    const flat = flattenBrowserBookmarks(tree, '1', null);
    expect(flat[0].folderPath).toEqual(['工作']);
  });
});

// ---------------------------------------------------------------------------

describe('runCategoryBuild — promote mode (P6-A)', () => {
  let chrome: ReturnType<typeof buildChrome>;

  beforeEach(() => {
    chrome = buildChrome();
    (globalThis as any).chrome = chrome;
  });

  it('builds category folders at the bar root, never creates TagNest, leaves user bookmarks intact', async () => {
    chrome.bookmarks.getTree.mockResolvedValue(
      barTree([
        { id: 'wk', title: '工作', children: [{ id: 'wb', url: 'https://work.com/x', title: '工作书签' }] },
        { id: 'loose', url: 'https://loose.com/y', title: '散落书签' },
      ]),
    );
    vi.stubGlobal('fetch', feedFetch([
      { bookmarkId: 'b1', url: 'https://a.com/1', title: 'React', categoryPath: ['开发技术'] },
      { bookmarkId: 'b2', url: 'https://a.com/2', title: 'Figma', categoryPath: ['在线工具'] },
    ]));

    const { runCategoryBuild } = await import('../extension/bg/reconcile.js');
    const res = await runCategoryBuild(cfg(true), {});

    expect(res.ok).toBe(true);
    expect(res.stats.foldersToCreate).toBe(2);
    expect(res.stats.bookmarksToCreate).toBe(2);

    const creates = chrome.bookmarks.create.mock.calls.map((c: any) => c[0]);
    const titles = creates.map((c: any) => c.title);
    expect(titles).toContain('开发技术');
    expect(titles).toContain('在线工具');
    expect(titles).toContain('React');
    expect(titles).toContain('Figma');
    expect(titles).not.toContain('TagNest'); // never creates a TagNest folder

    // Folders are created at the bar root (parentId '1'), i.e. top-level.
    const folderCreates = creates.filter((c: any) => !c.url);
    for (const f of folderCreates) expect(f.parentId).toBe('1');

    // C3-7 in promote mode: no removal of anything — the user's other
    // bookmarks/folders must be left exactly as they were.
    expect(chrome.bookmarks.removeTree).not.toHaveBeenCalled();
    expect(chrome.bookmarks.remove).not.toHaveBeenCalled();

    // Ownership manifest + per-op backup persisted.
    const manifest = chrome.storage.local.data['tagnestCategoryBuild.v0'];
    expect(manifest).toBeTruthy();
    expect(manifest.folders.map((p: string[]) => p.join(' > ')).sort()).toEqual(
      ['开发技术', '在线工具'].sort(),
    );
    expect(chrome.storage.local.data['tagnestCategoryOpBackup.v0']).toBeTruthy();
  });

  it('rolls back a move + create surgically, never touching the user folder or the bar', async () => {
    // Pre-existing ownership: b1 owned at 开发技术. 开发技术 also holds b3 so
    // it stays non-empty (and is NOT removed), making the move reversible.
    chrome.storage.local.data['tagnestCategoryBuild.v0'] = {
      version: 1,
      bookmarks: { 'a.com/x': ['开发技术'], 'a.com/z': ['开发技术'] },
      folders: [['开发技术']],
    };
    chrome.bookmarks.getTree.mockResolvedValue(
      barTree([
        {
          id: 'fdev',
          title: '开发技术',
          children: [
            { id: 'b1', url: 'https://a.com/x', title: 'React', parentId: 'fdev' },
            { id: 'b3', url: 'https://a.com/z', title: 'Node', parentId: 'fdev' },
          ],
        },
        { id: 'ftool', title: '在线工具', children: [] },
        { id: 'wk', title: '工作', children: [{ id: 'wb', url: 'https://work.com/x', title: '工作书签' }] },
      ]),
    );
    vi.stubGlobal('fetch', feedFetch([
      { bookmarkId: 'b1', url: 'https://a.com/x', title: 'React', categoryPath: ['在线工具'] }, // move
      { bookmarkId: 'b3', url: 'https://a.com/z', title: 'Node', categoryPath: ['开发技术'] }, // unchanged
      { bookmarkId: 'b2', url: 'https://a.com/2', title: '菜谱', categoryPath: ['生活'] }, // new
    ]));

    const { runCategoryBuild, rollbackCategoryBuild } = await import('../extension/bg/reconcile.js');
    const built = await runCategoryBuild(cfg(true), {});
    expect(built.ok).toBe(true);
    expect(built.stats.bookmarksToMove).toBe(1);
    expect(built.stats.foldersToCreate).toBe(1); // 生活

    // The move placed b1 under 在线工具 (ftool). Find that call.
    const moveCall = chrome.bookmarks.move.mock.calls.find((c: any) => c[0] === 'b1');
    expect(moveCall).toBeTruthy();
    expect(moveCall[1].parentId).toBe('ftool');

    // Reset move/remove spies to isolate the rollback's own calls.
    chrome.bookmarks.move.mockClear();
    chrome.bookmarks.removeTree.mockClear();
    chrome.bookmarks.remove.mockClear();
    chrome.bookmarks.create.mockClear();

    const rb = await rollbackCategoryBuild();
    expect(rb.ok).toBe(true);

    // Move reversed: b1 goes back to 开发技术 (fdev).
    const reverseMove = chrome.bookmarks.move.mock.calls.find((c: any) => c[0] === 'b1');
    expect(reverseMove).toBeTruthy();
    expect(reverseMove[1].parentId).toBe('fdev');

    // Created folder 生活 + its bookmark removed; the user folder 工作 and its
    // bookmark wb are NEVER touched.
    expect(chrome.bookmarks.removeTree).toHaveBeenCalled(); // 生活 removed
    expect(chrome.bookmarks.removeTree).not.toHaveBeenCalledWith('1'); // never the bar
    expect(chrome.bookmarks.removeTree).not.toHaveBeenCalledWith('wk'); // never user folder
    expect(chrome.bookmarks.remove).not.toHaveBeenCalledWith('wb'); // never user bookmark
    const removedIds = chrome.bookmarks.remove.mock.calls.map((c: any) => c[0]);
    expect(removedIds).not.toContain('wb');
  });

  it('preview reports mode "bar" in promote mode', async () => {
    chrome.bookmarks.getTree.mockResolvedValue(barTree([]));
    vi.stubGlobal('fetch', feedFetch([]));
    const { previewCategoryBuild } = await import('../extension/bg/reconcile.js');
    const resp = await previewCategoryBuild(cfg(true), undefined as any);
    expect(resp.ok).toBe(true);
    expect(resp.mode).toBe('bar');
  });

  it('preview reports mode "tagnest" when promote is off', async () => {
    chrome.bookmarks.getTree.mockResolvedValue(barTree([]));
    vi.stubGlobal('fetch', feedFetch([]));
    const { previewCategoryBuild } = await import('../extension/bg/reconcile.js');
    const resp = await previewCategoryBuild(cfg(false), undefined as any);
    expect(resp.mode).toBe('tagnest');
  });
});

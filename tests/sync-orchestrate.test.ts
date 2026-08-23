// tests/sync-orchestrate.test.ts
//
// Exercises the sync orchestration in extension/bg/reconcile.js with a tamed
// `chrome` + `fetch`: full upload push, two-way create-into-browser, and the
// snapshot rollback path. Verifies the wiring (pull pagination → planSync →
// syncPush / chrome.bookmarks writes → persisted watermark+snapshot) end to end
// without a live extension host.

import { describe, it, expect, beforeEach, vi } from 'vitest';

function buildChrome() {
  const storage = { data: {}, get: vi.fn(), set: vi.fn(), remove: vi.fn() };
  storage.get.mockImplementation(async (keys) => {
    const arr = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of arr) if (k in storage.data) out[k] = storage.data[k];
    return out;
  });
  storage.set.mockImplementation(async (obj) => {
    Object.assign(storage.data, obj);
  });
  storage.remove.mockImplementation(async (keys) => {
    for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage.data[k];
  });
  const bookmarks = {
    getTree: vi.fn(),
    get: vi.fn().mockResolvedValue([]),
    getChildren: vi.fn().mockResolvedValue([]),
    getSubTree: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const permissions = { contains: vi.fn().mockResolvedValue(true), request: vi.fn().mockResolvedValue(true) };
  return { storage: { local: storage }, bookmarks, permissions };
}

const cfg = { baseUrl: 'https://tagnest.pages.dev', apiKey: 'tnk_abc' };

function fetchResponse(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}

const browserTree = (leaves: { id: string; url: string; title: string }[]) => [
  { id: '0', children: [{ id: '1', children: leaves }] },
];

describe('runSync — upload direction', () => {
  let chrome: ReturnType<typeof buildChrome>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    chrome = buildChrome();
    globalThis.chrome = chrome as any;
    chrome.bookmarks.getTree.mockResolvedValue(
      browserTree([{ id: 'b1', url: 'https://a.com/x', title: 'A' }]),
    );
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/sync-pull')) {
        return fetchResponse(200, { items: [], cursor: null, hasMore: false });
      }
      if (String(url).includes('/sync-push')) {
        return fetchResponse(200, { applied: 1, failed: 0, errors: [] });
      }
      return fetchResponse(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('pushes a browser-only bookmark and persists the watermark', async () => {
    const { runSync } = await import('../extension/bg/reconcile.js');
    const res = await runSync(cfg, { direction: 'upload' });
    expect(res.pushed.applied).toBe(1);
    expect(res.applied.created).toBe(0); // upload never writes the browser tree

    const postCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/sync-push'));
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall[1].body);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ op: 'upsert', url: 'https://a.com/x', title: 'A' });

    // State persisted with the watermark from the pulled changelog. The
    // snapshot now records the category dimension (null = outside managed tree).
    const saved = chrome.storage.local.data['tagnestSync.v0'];
    expect(saved).toBeTruthy();
    expect(saved.snapshot['a.com/x']).toEqual({ title: 'A', tagNames: [], categoryPath: null });
  });

  it('pushes the managed folder path as categoryPath for a managed bookmark', async () => {
    // Tree: bar > TagNest(managed) > 开发技术 > bookmark
    chrome.bookmarks.getTree.mockResolvedValue([
      {
        id: '0',
        children: [
          {
            id: '1',
            children: [
              {
                id: 'tn',
                title: 'TagNest',
                children: [
                  {
                    id: 'f1',
                    title: '开发技术',
                    children: [{ id: 'b1', url: 'https://a.com/x', title: 'A' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const { runSync } = await import('../extension/bg/reconcile.js');
    const res = await runSync(cfg, { direction: 'upload' });
    expect(res.pushed.applied).toBe(1);
    expect(res.categoryStats.pushed).toBe(1);

    const postCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/sync-push'));
    const body = JSON.parse(postCall[1].body);
    expect(body.changes[0].categoryPath).toEqual(['开发技术']);

    const saved = chrome.storage.local.data['tagnestSync.v0'];
    expect(saved.snapshot['a.com/x'].categoryPath).toEqual(['开发技术']);
  });
});

describe('runSync — two-way direction', () => {
  let chrome: ReturnType<typeof buildChrome>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    chrome = buildChrome();
    globalThis.chrome = chrome as any;
    chrome.bookmarks.getTree.mockResolvedValue(browserTree([]));
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/sync-pull')) {
        return fetchResponse(200, {
          items: [
            { id: 't1', urlKey: 'a.com/y', url: 'https://a.com/y', title: 'Y', tagNames: [], updatedAt: '2024-01-01', deletedAt: null },
          ],
          cursor: null,
          hasMore: false,
        });
      }
      return fetchResponse(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    // First create is the "TagNest" folder, second is the bookmark.
    chrome.bookmarks.create
      .mockResolvedValueOnce({ id: 'tnfolder', parentId: '1', title: 'TagNest' })
      .mockResolvedValueOnce({ id: 'new', parentId: 'tnfolder', url: 'https://a.com/y', title: 'Y' });
  });

  it('creates a browser bookmark for a TagNest-only entry and backs up the snapshot', async () => {
    const { runSync } = await import('../extension/bg/reconcile.js');
    const res = await runSync(cfg, { direction: 'two-way' });
    expect(res.applied.created).toBe(1);
    const bookmarkCreate = chrome.bookmarks.create.mock.calls.find((c) => c[0].url === 'https://a.com/y');
    expect(bookmarkCreate).toBeTruthy();
    expect(bookmarkCreate[0].parentId).toBe('tnfolder');
    // A backup was recorded so the write can be rolled back.
    expect(chrome.storage.local.data['tagnestSyncBackup.v0']).toBeTruthy();
  });

  it('places a TagNest-only bookmark into its cloud category folder chain', async () => {
    // Override the pull feed: the entry carries a two-level categoryPath.
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sync-pull')) {
        return fetchResponse(200, {
          items: [
            {
              id: 't1',
              urlKey: 'a.com/y',
              url: 'https://a.com/y',
              title: 'Y',
              tagNames: [],
              categoryPath: ['开发技术', '前端'],
              updatedAt: '2024-01-01',
              deletedAt: null,
            },
          ],
          cursor: null,
          hasMore: false,
        });
      }
      return fetchResponse(404, {});
    });
    // getChildren returns no existing folders, so both levels get created.
    chrome.bookmarks.getChildren.mockResolvedValue([]);
    // Reset the create mock: beforeEach queued once-values for the flat case.
    chrome.bookmarks.create.mockReset();
    chrome.bookmarks.create
      .mockResolvedValueOnce({ id: 'tnfolder', parentId: '1', title: 'TagNest' })
      .mockResolvedValueOnce({ id: 'f-dev', parentId: 'tnfolder', title: '开发技术' })
      .mockResolvedValueOnce({ id: 'f-fe', parentId: 'f-dev', title: '前端' })
      .mockResolvedValueOnce({ id: 'new', parentId: 'f-fe', url: 'https://a.com/y', title: 'Y' });

    const { runSync } = await import('../extension/bg/reconcile.js');
    const res = await runSync(cfg, { direction: 'two-way' });
    expect(res.applied.created).toBe(1);
    expect(res.categoryStats.appliedCreates).toBe(1);

    // The bookmark lands in the deepest category folder, not the managed root.
    const bookmarkCreate = chrome.bookmarks.create.mock.calls.find((c) => c[0].url === 'https://a.com/y');
    expect(bookmarkCreate[0].parentId).toBe('f-fe');

    // Snapshot records the applied cloud category as the next merge base.
    const saved = chrome.storage.local.data['tagnestSync.v0'];
    expect(saved.snapshot['a.com/y'].categoryPath).toEqual(['开发技术', '前端']);
  });

  it('moves a managed bookmark when the cloud re-categorised it (local unchanged)', async () => {
    // Browser: managed folder > 旧分类 > bookmark. Cloud changed to 新分类.
    chrome.bookmarks.getTree.mockResolvedValue([
      {
        id: '0',
        children: [
          {
            id: '1',
            children: [
              {
                id: 'tn',
                title: 'TagNest',
                children: [
                  {
                    id: 'f-old',
                    title: '旧分类',
                    children: [{ id: 'b1', url: 'https://a.com/x', title: 'A' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    // Snapshot base: the bookmark used to be in 旧分类 on both sides.
    chrome.storage.local.data['tagnestSync.v0'] = {
      lastSyncedAt: '',
      snapshot: { 'a.com/x': { title: 'A', tagNames: [], categoryPath: ['旧分类'] } },
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sync-pull')) {
        return fetchResponse(200, {
          items: [
            {
              id: 't1',
              urlKey: 'a.com/x',
              url: 'https://a.com/x',
              title: 'A',
              tagNames: [],
              categoryPath: ['新分类'],
              updatedAt: '2024-06-01',
              deletedAt: null,
            },
          ],
          cursor: null,
          hasMore: false,
        });
      }
      return fetchResponse(404, {});
    });
    // getChildren: no 新分类 folder yet → it gets created.
    chrome.bookmarks.getChildren.mockResolvedValue([]);
    // Reset create mock: beforeEach queued once-values for the flat case.
    chrome.bookmarks.create.mockReset();
    chrome.bookmarks.create.mockResolvedValue({ id: 'f-new', parentId: 'tn', title: '新分类' });
    // get() returns the node so the backup captures its pre-move parentId.
    chrome.bookmarks.get.mockResolvedValue([{ id: 'b1', title: 'A', parentId: 'f-old' }]);

    const { runSync } = await import('../extension/bg/reconcile.js');
    const res = await runSync(cfg, { direction: 'two-way' });
    expect(res.applied.moved).toBe(1);
    // Nothing pushed: the local side did not change.
    expect(res.pushed.applied).toBe(0);
    // The move targeted the freshly created 新分类 folder.
    expect(chrome.bookmarks.move).toHaveBeenCalledWith('b1', { parentId: 'f-new' });
    // Backup captured the original parent so rollback can restore it.
    const backup = chrome.storage.local.data['tagnestSyncBackup.v0'];
    expect(backup.updated[0]).toMatchObject({ id: 'b1', parentId: 'f-old' });
    // Snapshot converged on the cloud category.
    const saved = chrome.storage.local.data['tagnestSync.v0'];
    expect(saved.snapshot['a.com/x'].categoryPath).toEqual(['新分类']);
  });
});

describe('resolveAutoSync — C5-5 auto-sync policy', () => {
  it('disables when not configured', async () => {
    const { resolveAutoSync } = await import('../extension/bg/reconcile.js');
    const policy = resolveAutoSync({ configured: false, autoSync: true, autoSyncMinutes: 5 });
    expect(policy.enabled).toBe(false);
  });

  it('disables when the user toggled autoSync off', async () => {
    const { resolveAutoSync } = await import('../extension/bg/reconcile.js');
    const policy = resolveAutoSync({ configured: true, autoSync: false, autoSyncMinutes: 5 });
    expect(policy.enabled).toBe(false);
  });

  it('enables with the requested interval when configured and on', async () => {
    const { resolveAutoSync } = await import('../extension/bg/reconcile.js');
    const policy = resolveAutoSync({ configured: true, autoSync: true, autoSyncMinutes: 5 });
    expect(policy).toEqual({ enabled: true, minutes: 5, direction: 'upload' });
  });

  it('clamps the interval into 1..120 minutes', async () => {
    const { resolveAutoSync } = await import('../extension/bg/reconcile.js');
    expect(resolveAutoSync({ configured: true, autoSync: true, autoSyncMinutes: 0 }).minutes).toBe(1);
    expect(resolveAutoSync({ configured: true, autoSync: true, autoSyncMinutes: 999 }).minutes).toBe(120);
    expect(resolveAutoSync({ configured: true, autoSync: true, autoSyncMinutes: NaN }).minutes).toBe(5);
  });

  it('follows the last manual direction (two-way)', async () => {
    const { resolveAutoSync } = await import('../extension/bg/reconcile.js');
    const policy = resolveAutoSync({
      configured: true,
      autoSync: true,
      autoSyncMinutes: 5,
      lastDirection: 'two-way',
    });
    expect(policy.direction).toBe('two-way');
  });

  it('defaults to upload when no manual direction was recorded', async () => {
    const { resolveAutoSync } = await import('../extension/bg/reconcile.js');
    const policy = resolveAutoSync({ configured: true, autoSync: true, autoSyncMinutes: 5, lastDirection: '' });
    expect(policy.direction).toBe('upload');
  });
});

describe('runSync — autoSync direction persistence', () => {
  let chrome: ReturnType<typeof buildChrome>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    chrome = buildChrome();
    globalThis.chrome = chrome as any;
    chrome.bookmarks.getTree.mockResolvedValue(browserTree([]));
    fetchMock = vi.fn(async () => fetchResponse(200, { items: [], cursor: null, hasMore: false }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('persists lastDirection so auto sync can follow the manual choice', async () => {
    const { runSync } = await import('../extension/bg/reconcile.js');
    await runSync(cfg, { direction: 'two-way' });
    const saved = chrome.storage.local.data['tagnestSync.v0'];
    expect(saved.lastDirection).toBe('two-way');
  });
});

describe('getSyncStatus — C5-4 popup sync status (CS-P4-2)', () => {
  let chrome: ReturnType<typeof buildChrome>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    chrome = buildChrome();
    globalThis.chrome = chrome as any;
    // Browser holds one bookmark the cloud does not know yet.
    chrome.bookmarks.getTree.mockResolvedValue(
      browserTree([{ id: 'b1', url: 'https://a.com/x', title: 'A' }]),
    );
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/sync-keys')) {
        return fetchResponse(200, { items: [], cursor: null, hasMore: false });
      }
      if (String(url).includes('/api/stats')) {
        return fetchResponse(200, { bookmarks: 10, categorized: 4 });
      }
      return fetchResponse(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('reports last sync, pending upload and category coverage', async () => {
    chrome.storage.local.data['tagnestSync.v0'] = {
      lastSyncedAt: '2026-08-23T00:00:00.000Z',
      snapshot: {},
      lastDirection: 'two-way',
    };
    const { getSyncStatus } = await import('../extension/bg/reconcile.js');
    const status = await getSyncStatus(cfg);
    expect(status.lastSyncedAt).toBe('2026-08-23T00:00:00.000Z');
    expect(status.lastDirection).toBe('two-way');
    expect(status.pendingUpload).toBe(1); // b1 is not in the cloud key set
    expect(status.coverage).toEqual({ categorized: 4, bookmarks: 10, percent: 40 });
  });

  it('returns nulls (not errors) when unconfigured', async () => {
    const { getSyncStatus } = await import('../extension/bg/reconcile.js');
    const status = await getSyncStatus({ baseUrl: '', apiKey: '' });
    expect(status.lastSyncedAt).toBe('');
    expect(status.pendingUpload).toBeNull();
    expect(status.coverage).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades gracefully when the stats endpoint fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sync-keys')) {
        return fetchResponse(200, { items: [], cursor: null, hasMore: false });
      }
      return fetchResponse(500, {});
    });
    const { getSyncStatus } = await import('../extension/bg/reconcile.js');
    const status = await getSyncStatus(cfg);
    expect(status.pendingUpload).toBe(1); // diff still worked
    expect(status.coverage).toBeNull(); // stats failed → dash, not throw
  });
});

describe('rollbackSync', () => {
  let chrome: ReturnType<typeof buildChrome>;

  beforeEach(() => {
    chrome = buildChrome();
    globalThis.chrome = chrome as any;
    chrome.bookmarks.get.mockResolvedValue([]);
    chrome.storage.local.data['tagnestSyncBackup.v0'] = {
      created: [{ id: 'c1', parentId: '1', url: 'https://a.com/y', title: 'Y' }],
      updated: [{ id: 'b1', title: 'Old' }],
      removed: [],
    };
  });

  it('reverses created/updated writes and clears the backup', async () => {
    const { rollbackSync } = await import('../extension/bg/reconcile.js');
    const res = await rollbackSync();
    expect(res.ok).toBe(true);
    expect(chrome.bookmarks.remove).toHaveBeenCalledWith('c1');
    expect(chrome.bookmarks.update).toHaveBeenCalledWith('b1', { title: 'Old' });
    expect(chrome.storage.local.data['tagnestSyncBackup.v0']).toBeUndefined();
  });

  it('reports when there is nothing to roll back', async () => {
    delete chrome.storage.local.data['tagnestSyncBackup.v0'];
    const { rollbackSync } = await import('../extension/bg/reconcile.js');
    const res = await rollbackSync();
    expect(res.ok).toBe(false);
  });
});

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
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue(undefined),
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

    // State persisted with the watermark from the pulled changelog.
    const saved = chrome.storage.local.data['tagnestSync.v0'];
    expect(saved).toBeTruthy();
    expect(saved.snapshot['a.com/x']).toEqual({ title: 'A', tagNames: [] });
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

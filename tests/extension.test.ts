// Unit tests for the pure extension logic that doesn't need a live extension
// host. We fake the global `chrome` to exercise config/persistence, tab
// filtering, and the API client's error/duplicate handling.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Minimal tamed `chrome` shim. Each test installs its own behaviour via the
// builder below; importing the extend modules pulls this in only if we ask it to.
function buildChrome(overrides = {}) {
  const storage = { data: {}, get: vi.fn(), set: vi.fn(), remove: vi.fn() };
  storage.get.mockImplementation(async (keys) => {
    const keysArr = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of keysArr) if (k in storage.data) out[k] = storage.data[k];
    return out;
  });
  storage.set.mockImplementation(async (obj) => { Object.assign(storage.data, obj); });
  storage.remove.mockImplementation(async (keys) => {
    for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage.data[k];
  });
  return {
    storage: { local: storage },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

// Import after instantiating chrome, because the module only reads it lazily.
async function load({ chrome }) {
  globalThis.chrome = chrome;
  const [{ windowGroupName }, { saveConfig, loadConfig }, { ApiError }, apiClient] = await Promise.all([
    import('../extension/bg/tabs.js'),
    import('../extension/bg/config.js'),
    import('../extension/bg/api.js'),
    import('../extension/bg/api.js'),
  ]);
  return { windowGroupName, saveConfig, loadConfig, ApiError, apiClient };
}

describe('extension: windowGroupName', () => {
  it('names a single tab plainly', async () => {
    const { windowGroupName } = await load({ chrome: buildChrome() });
    expect(windowGroupName(1)).toBe('标签页');
    expect(windowGroupName(0)).toBe('标签页');
  });

  it('names multi-tab batches with a count', async () => {
    const { windowGroupName } = await load({ chrome: buildChrome() });
    expect(windowGroupName(2)).toBe('2 个标签页');
    expect(windowGroupName(12)).toBe('12 个标签页');
  });
});

describe('extension: config', () => {
  let chrome;

  beforeEach(() => {
    chrome = buildChrome();
    globalThis.chrome = chrome;
  });

  it('starts with defaults when nothing is stored', async () => {
    const { loadConfig } = await import('../extension/bg/config.js');
    const cfg = await loadConfig();
    expect(cfg.baseUrl).toBe('https://tagnest.pages.dev');
    expect(cfg.apiKey).toBe('');
  });

  it('saves and reloads a configured key + url', async () => {
    const { saveConfig, loadConfig } = await import('../extension/bg/config.js');
    await saveConfig({ baseUrl: 'https://example.com', apiKey: 'tnk_123' });
    const cfg = await loadConfig();
    expect(cfg.baseUrl).toBe('https://example.com');
    expect(cfg.apiKey).toBe('tnk_123');
  });

  it('rejects a key that does not start with tnk_', async () => {
    const { saveConfig } = await import('../extension/bg/config.js');
    await expect(saveConfig({ apiKey: 'not-a-key' })).rejects.toThrow(/tnk_/);
  });

  it('rejects a malformed base URL', async () => {
    const { saveConfig } = await import('../extension/bg/config.js');
    await expect(saveConfig({ baseUrl: 'ftp://nope' })).rejects.toThrow(/http/);
    await expect(saveConfig({ baseUrl: 'tagnest.pages.dev' })).rejects.toThrow(/http/);
  });
});

describe('extension: ApiError classification', () => {
  it('is an Error subclass carrying status and detail', async () => {
    const { ApiError } = await import('../extension/bg/api.js');
    const e = new ApiError(409, 'dup', { id: 'b_1' });
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(409);
    expect(e.detail).toEqual({ id: 'b_1' });
    expect(e.message).toBe('dup');
  });
});

describe('extension: api client idempotency', () => {
  let chrome;
  const cfg = { baseUrl: 'https://tagnest.pages.dev', apiKey: 'tnk_abc' };

  beforeEach(() => {
    chrome = buildChrome();
    globalThis.chrome = chrome;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function fetchResponse(status, body, headers) {
    return {
      ok: status < 400,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
      headers,
    };
  }

  it('ensureBookmark reuses existing id on 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      fetchResponse(409, { error: { message: '已在书签库中', fields: { id: 'b_existing' } } }),
    ));
    const { ensureBookmark } = await import('../extension/bg/api.js');
    const out = await ensureBookmark(cfg, { url: 'https://a.com', title: 'A' });
    expect(out).toEqual({ id: 'b_existing', existed: true });
  });

  it('ensureBookmark records a fresh save on 201', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      fetchResponse(201, { id: 'b_new', url: 'https://a.com' }),
    ));
    const { ensureBookmark } = await import('../extension/bg/api.js');
    const out = await ensureBookmark(cfg, { url: 'https://a.com', title: 'A' });
    expect(out).toEqual({ id: 'b_new', existed: false });
  });

  it('maps 401 to the backend-provided message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(401, { error: { message: '未授权' } })));
    const { ensureBookmark, ApiError } = await import('../extension/bg/api.js');
    await expect(ensureBookmark(cfg, { url: 'https://a.com', title: 'A' }))
      .rejects.toBeInstanceOf(ApiError);
    await expect(ensureBookmark(cfg, { url: 'https://a.com', title: 'A' }))
      .rejects.toThrow('未授权');
  });

  it('createGroup passes name and an integer colorIndex', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fetchResponse(201, { id: 'g_1', name: '3 个标签页' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createGroup } = await import('../extension/bg/api.js');
    const group = await createGroup(cfg, { name: '3 个标签页', colorIndex: 2 });
    expect(group.id).toBe('g_1');
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody).toEqual({ name: '3 个标签页', colorIndex: 2 });
  });

  it('addGroupItem targets the group items route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fetchResponse(201, { id: 'item1' }));
    vi.stubGlobal('fetch', fetchMock);
    const { addGroupItem } = await import('../extension/bg/api.js');
    const item = await addGroupItem(cfg, 'g_1', 'b_1');
    expect(item.id).toBe('item1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://tagnest.pages.dev/api/tab-groups/g_1/items');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ bookmarkId: 'b_1' });
  });

  it('reports a connection failure with a friendly message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { ensureBookmark, ApiError } = await import('../extension/bg/api.js');
    await expect(ensureBookmark(cfg, { url: 'https://a.com', title: 'A' }))
      .rejects.toBeInstanceOf(ApiError);
    await expect(ensureBookmark(cfg, { url: 'https://a.com', title: 'A' }))
      .rejects.toThrow(/无法连接/);
  });
});

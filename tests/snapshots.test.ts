import { describe, expect, it, vi } from 'vitest';
import {
  captureWithBrowserRun,
  classifySnapshotError,
  fetchSnapshotFromApi,
  getSnapshot,
  putSnapshot,
  resolveSnapshotProvider,
  snapshotServePath,
} from '../functions/_lib/snapshots';

// Minimal in-memory R2Bucket-like stub covering the surface the snapshots lib
// uses (put / get). WebAssembly bytes are just length-checked here; the lib
// never inspects them.
function memR2() {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  const bucket = {
    async put(
      key: string,
      value: Uint8Array,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      store.set(key, {
        body: new Uint8Array(value),
        contentType: opts?.httpMetadata?.contentType ?? 'image/webp',
      });
      return {} as R2Object;
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      const hit = store.get(key);
      if (!hit) return null;
      return { body: asReadableStream(hit.body), httpMetadata: { contentType: hit.contentType } } as R2ObjectBody;
    },
    _keys: () => [...store.keys()],
  };
  return bucket;
}

function asReadableStream(bytes: Uint8Array): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A fetch that returns a canned image body + content type. */
function mockFetch(init: { status?: number; contentType?: string; bytes?: Uint8Array } = {}) {
  const {
    status = 200,
    contentType = 'image/webp',
    bytes = new Uint8Array([1, 2, 3, 4, 5]),
  } = init;
  return vi.fn(async () =>
    new Response(bytes, { status, headers: { 'content-type': contentType } }),
  );
}

const userId = 'user_abc';
const bookmarkId = 'bookmark_123';

describe('fetchSnapshotFromApi', () => {
  it('throws when no external API URL is configured (Browser Run is the default path)', async () => {
    const fetchFn = mockFetch();
    await expect(
      fetchSnapshotFromApi('https://example.com', { fetchFn }),
    ).rejects.toThrow('SNAPSHOT_API_URL 未配置');
  });

  it('prefers an explicitly configured API URL', async () => {
    const fetchFn = mockFetch();
    await fetchSnapshotFromApi('https://a.com', {
      apiUrl: 'https://shot.dev/?url={url}&format=webp',
      fetchFn,
    });
    const [calledUrl] = fetchFn.mock.calls[0] as unknown as [string];
    expect(calledUrl).toContain('shot.dev');
    expect(calledUrl).toContain('https%3A%2F%2Fa.com');
  });

  it('replaces the {url} token with the encoded target', async () => {
    const fetchFn = mockFetch();
    await fetchSnapshotFromApi('https://a.com/x?b=1', {
      apiUrl: 'https://shot.dev/?url={url}',
      fetchFn,
    });
    const [calledUrl] = fetchFn.mock.calls[0] as unknown as [string];
    expect(calledUrl).toContain('https%3A%2F%2Fa.com%2Fx%3Fb%3D1');
  });

  it('sends a Bearer key when provided', async () => {
    const fetchFn = mockFetch();
    await fetchSnapshotFromApi('https://example.com', {
      apiUrl: 'https://shot.dev/',
      apiKey: 'secret',
      fetchFn,
    });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
  });

  it('sends a browser User-Agent by default and honours an override', async () => {
    const fetchFn = mockFetch();
    await fetchSnapshotFromApi('https://a.com', { apiUrl: 'https://shot.dev/', fetchFn });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const ua = (init.headers as Record<string, string>)['user-agent'];
    expect(ua).toMatch(/\bChrome\//);

    const fetchFn2 = mockFetch();
    await fetchSnapshotFromApi('https://a.com', {
      apiUrl: 'https://shot.dev/',
      userAgent: 'custom-agent',
      fetchFn: fetchFn2,
    });
    const [, init2] = fetchFn2.mock.calls[0] as unknown as [string, RequestInit];
    expect((init2.headers as Record<string, string>)['user-agent']).toBe('custom-agent');
  });

  it('throws on non-2xx from the provider', async () => {
    const fetchFn = mockFetch({ status: 502 });
    await expect(
      fetchSnapshotFromApi('https://example.com', { apiUrl: 'https://shot.dev/', fetchFn }),
    ).rejects.toThrow('返回 502');
  });

  it('throws on an empty body', async () => {
    const fetchFn = mockFetch({ bytes: new Uint8Array(0) });
    await expect(
      fetchSnapshotFromApi('https://example.com', { apiUrl: 'https://shot.dev/', fetchFn }),
    ).rejects.toThrow('空响应');
  });

  it('resolves to bytes + content type on success', async () => {
    const fetchFn = mockFetch({ contentType: 'image/png' });
    const out = await fetchSnapshotFromApi('https://example.com', {
      apiUrl: 'https://shot.dev/',
      fetchFn,
    });
    expect(out.bytes.byteLength).toBe(5);
    expect(out.contentType).toBe('image/png');
  });
});

describe('resolveSnapshotProvider', () => {
  it('external wins when SNAPSHOT_API_URL is set', () => {
    expect(resolveSnapshotProvider({ SNAPSHOT_API_URL: 'https://shot.dev/' })).toBe(
      'external',
    );
  });

  it('browser is used when only the BROWSER binding is present', () => {
    expect(
      resolveSnapshotProvider({ BROWSER: {} as BrowserRun }),
    ).toBe('browser');
  });

  it('external wins over browser when both are present', () => {
    expect(
      resolveSnapshotProvider({ SNAPSHOT_API_URL: 'https://shot.dev/', BROWSER: {} as BrowserRun }),
    ).toBe('external');
  });

  it('none when neither is available', () => {
    expect(resolveSnapshotProvider({})).toBe('none');
  });
});

describe('captureWithBrowserRun', () => {
  it('captures via BROWSER.quickAction and returns validated bytes', async () => {
    const quickAction = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3, 4, 5]), { headers: { 'content-type': 'image/webp' } }),
    );
    const env = { BROWSER: { quickAction } };
    const out = await captureWithBrowserRun(env, 'https://example.com');
    expect(out.bytes.byteLength).toBe(5);
    expect(out.contentType).toBe('image/webp');
    expect(quickAction).toHaveBeenCalledWith('screenshot', {
      url: 'https://example.com',
      screenshotOptions: {},
    });
  });

  it('throws when the BROWSER binding is absent', async () => {
    await expect(captureWithBrowserRun({}, 'https://example.com')).rejects.toThrow(
      'BROWSER (Browser Run) 未绑定',
    );
  });
});

describe('putSnapshot / getSnapshot', () => {
  it('stores bytes under the namespace key and reads them back', async () => {
    const bucket = memR2();
    const bytes = new Uint8Array([9, 8, 7]);
    const key = await putSnapshot(
      { SNAPSHOT_BUCKET: bucket },
      userId,
      bookmarkId,
      bytes,
      'image/webp',
    );
    expect(key).toBe(`snapshots/${userId}/${bookmarkId}.webp`);
    expect(bucket._keys()).toEqual([key]);

    const obj = await getSnapshot({ SNAPSHOT_BUCKET: bucket }, key);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata!.contentType).toBe('image/webp');
  });

  it('getSnapshot returns null for a missing key', async () => {
    const bucket = memR2();
    const obj = await getSnapshot(
      { SNAPSHOT_BUCKET: bucket },
      `snapshots/${userId}/nope.webp`,
    );
    expect(obj).toBeNull();
  });

  it('returns null when the bucket binding is absent', async () => {
    const obj = await getSnapshot({}, `snapshots/${userId}/${bookmarkId}.webp`);
    expect(obj).toBeNull();
  });
});

describe('snapshotServePath', () => {
  it('builds the unauthenticated image path from owner + bookmark', () => {
    expect(snapshotServePath(userId, bookmarkId)).toBe(
      `/api/snapshots/${encodeURIComponent(`snapshots/${userId}/${bookmarkId}.webp`)}`,
    );
  });
});

describe('classifySnapshotError', () => {
  it('maps each failure mode to a friendly message', () => {
    expect(classifySnapshotError(new Error('SNAPSHOT_API_URL 未配置')).kind).toBe(
      'not_configured',
    );
    expect(classifySnapshotError(new Error('截图服务返回了空响应')).kind).toBe('empty');
    expect(classifySnapshotError(new Error('截图服务返回的图片过大')).kind).toBe('too_large');
    expect(classifySnapshotError(new Error('SNAPSHOT_BUCKET 未绑定')).kind).toBe(
      'r2_unavailable',
    );
    expect(classifySnapshotError(new Error('boom')).kind).toBe('provider_error');
  });
});

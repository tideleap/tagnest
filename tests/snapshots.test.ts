import { describe, expect, it, vi } from 'vitest';
import {
  captureWithBrowserRun,
  classifySnapshotError,
  fetchSnapshotFromApi,
  getSnapshot,
  planRetention,
  putSnapshot,
  resolveSnapshotProvider,
  snapshotObjectKey,
  snapshotServePath,
  snapshotTimestamp,
  sortSnapshotsNewestFirst,
  storeSnapshotWithRetention,
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

  it('passes an abort signal so a silent provider cannot hang the request', async () => {
    const fetchFn = mockFetch();
    await fetchSnapshotFromApi('https://a.com', { apiUrl: 'https://shot.dev/', fetchFn });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timeout as "没有响应" rather than leaking an AbortError', async () => {
    // `fetch` has no default timeout: without the signal this call would sit
    // there until the platform killed the whole Worker invocation.
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
          );
        }),
    );

    await expect(
      fetchSnapshotFromApi('https://example.com', {
        apiUrl: 'https://shot.dev/',
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 10,
      }),
    ).rejects.toThrow('没有响应');
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
  it('stores bytes under a versioned key and reads them back', async () => {
    const bucket = memR2();
    const bytes = new Uint8Array([9, 8, 7]);
    const key = await putSnapshot(
      { SNAPSHOT_BUCKET: bucket },
      userId,
      bookmarkId,
      bytes,
      'image/webp',
      1000,
    );
    expect(key).toBe(`snapshots/${userId}/${bookmarkId}-1000.webp`);
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
  it('builds the unauthenticated image path from a full key', () => {
    const key = `snapshots/${userId}/${bookmarkId}-123.webp`;
    expect(snapshotServePath(key)).toBe(
      `/api/snapshots/${encodeURIComponent(key)}`,
    );
  });
});

describe('snapshotObjectKey / snapshotTimestamp', () => {
  it('embeds the timestamp and recovers it', () => {
    const key = snapshotObjectKey(userId, bookmarkId, 1712345678901);
    expect(key).toBe(`snapshots/${userId}/${bookmarkId}-1712345678901.webp`);
    expect(snapshotTimestamp(key)).toBe(1712345678901);
  });

  it('snapshotTimestamp returns 0 for a malformed or legacy bare key', () => {
    expect(snapshotTimestamp(`snapshots/${userId}/${bookmarkId}.webp`)).toBe(0);
    expect(snapshotTimestamp('not-a-key')).toBe(0);
  });
});

describe('sortSnapshotsNewestFirst', () => {
  it('orders by descending timestamp', () => {
    const a = snapshotObjectKey(userId, bookmarkId, 100);
    const b = snapshotObjectKey(userId, bookmarkId, 300);
    const c = snapshotObjectKey(userId, bookmarkId, 200);
    expect(sortSnapshotsNewestFirst([a, b, c])).toEqual([b, c, a]);
  });
});

describe('planRetention', () => {
  it('keeps everything when under the limit', () => {
    const key = snapshotObjectKey(userId, bookmarkId, 100);
    const { keep, drop } = planRetention([], key, 5);
    expect(keep).toEqual([key]);
    expect(drop).toEqual([]);
  });

  it('prunes the oldest when the limit is exceeded', () => {
    const a = snapshotObjectKey(userId, bookmarkId, 100);
    const d = snapshotObjectKey(userId, bookmarkId, 200);
    const e = snapshotObjectKey(userId, bookmarkId, 300);
    const newer = snapshotObjectKey(userId, bookmarkId, 400);
    // existing(a=oldest) then add d,e,newer with limit 3 → keep d,e,newer; drop a
    const { keep, drop } = planRetention([a, d, e], newer, 3);
    expect(keep).toEqual([d, e, newer]);
    expect(drop).toEqual([a]);
  });

  it('pins to the newest when the limit is 1', () => {
    const oldK = snapshotObjectKey(userId, bookmarkId, 10);
    const newK = snapshotObjectKey(userId, bookmarkId, 20);
    const { keep, drop } = planRetention([oldK], newK, 1);
    expect(drop).toEqual([oldK]);
    expect(keep).toEqual([newK]);
  });

  it('never prunes when the limit is -1 (unlimited)', () => {
    const a = snapshotObjectKey(userId, bookmarkId, 10);
    const b = snapshotObjectKey(userId, bookmarkId, 20);
    const { keep, drop } = planRetention([a], b, -1);
    expect(keep).toEqual([a, b]);
    expect(drop).toEqual([]);
  });
});

describe('storeSnapshotWithRetention', () => {
  it('writes a new version, keeps under limit, returns empty drop', async () => {
    const bucket = memR2();
    const existing = [snapshotObjectKey(userId, bookmarkId, 100)];
    await bucket.put(existing[0], new Uint8Array(3), { httpMetadata: { contentType: 'image/webp' } });
    const out = await storeSnapshotWithRetention(
      { SNAPSHOT_BUCKET: bucket },
      {
        userId,
        bookmarkId,
        existingKeys: existing,
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/webp',
        retentionLimit: 5,
        tsMs: 200,
      },
    );
    expect(out.key).toBe(snapshotObjectKey(userId, bookmarkId, 200));
    expect(out.keep).toEqual([...existing, out.key]);
    expect(out.drop).toEqual([]);
    expect(bucket._keys()).toEqual([...existing, out.key]);
  });

  it('prunes the oldest object when the limit is exceeded', async () => {
    const bucket = memR2();
    const a = snapshotObjectKey(userId, bookmarkId, 100);
    const b = snapshotObjectKey(userId, bookmarkId, 200);
    for (const k of [a, b]) await bucket.put(k, new Uint8Array(3), { httpMetadata: { contentType: 'image/webp' } });

    const out = await storeSnapshotWithRetention(
      { SNAPSHOT_BUCKET: bucket },
      {
        userId,
        bookmarkId,
        existingKeys: [a, b],
        bytes: new Uint8Array([9]),
        contentType: 'image/webp',
        retentionLimit: 2,
        tsMs: 300,
      },
    );
    expect(out.drop).toEqual([a]); // oldest pruned
    expect(out.keep).toEqual([b, out.key]);
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
    expect(classifySnapshotError(new Error('截图服务在 20 秒内没有响应'))).toEqual({
      kind: 'provider_error',
      message: '截图服务响应超时，请稍后重试',
    });
  });
});

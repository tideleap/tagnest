import type { Env } from './env';

/**
 * Website snapshots ("website preview image").
 *
 * Pipeline ownership:
 *   1. The backend captures an image of the bookmark's URL using either
 *      Cloudflare Browser Run (self-hosted on the same platform — preferred,
 *      reliable, no third party) or an optional external screenshot API.
 *   2. The bytes are uploaded to an R2 object at
 *      `snapshots/{userId}/{bookmarkId}.{ext}`; the key is stored on the
 *      bookmark row as `snapshot_key`.
 *   3. The card now serves the FIRST-PARTY image via the snapshot endpoint
 *      instead of the raw remote `coverUrl`.
 *
 * Every function is pure over its `Env` + injectable `fetch` so the unit tests
 * can exercise the whole flow with an in-memory R2 stub and a mocked remote.
 */

export const SNAPSHOT_EXT = 'webp';

/** Max bytes accepted as a snapshot image (≈ 4 MB). */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/**
 * How long the external screenshot API gets to answer before we abandon it.
 *
 * Rendering a page takes seconds, so the budget is generous — but it must
 * exist. `fetch` has no default timeout: a free screenshot service that
 * accepts the connection and then goes quiet used to pin the whole request
 * until the platform killed it, which means the user watched a spinner for
 * ~30s and got a generic 500, and the `waitUntil` capture on bookmark
 * creation held an invocation open for nothing.
 */
export const SNAPSHOT_FETCH_TIMEOUT_MS = 20_000;

/**
 * Which render source to use for a snapshot, in resolution order:
 *   1. external  — `SNAPSHOT_API_URL` is set; call that third-party service.
 *   2. browser   — no external URL, but the Cloudflare `BROWSER` (Browser Run)
 *                  binding is present; capture on the platform (no third party).
 *   3. none      — neither is available; the caller should return a clear error.
 *
 * A self-hosted Browser Run capture is the recommended default for deployments
 * that have the binding, because it runs on Cloudflare's own network (no risk
 * of datacenter-IP bans that plague free screenshot APIs) at no per-capture
 * cost on the free tier, and needs no API key or external request.
 */
export type SnapshotProvider = 'external' | 'browser' | 'none';

export function resolveSnapshotProvider(env: Pick<Env, 'SNAPSHOT_API_URL' | 'BROWSER'>): SnapshotProvider {
  if (env.SNAPSHOT_API_URL) return 'external';
  if (env.BROWSER) return 'browser';
  return 'none';
}

/**
 * Builds an R2 object key for a single snapshot capture.
 *
 * Format: `snapshots/{userId}/{bookmarkId}-{tsMs}.webp`
 *
 * The `-{tsMs}` suffix (unix epoch millis) makes each capture a distinct
 * object so a bookmark can keep a history of snapshots. The bookmark's own id
 * (NOT the userId) sits after the user separator, mirroring the pre-retention
 * layout while disambiguating versions by timestamp.
 */
export function snapshotObjectKey(userId: string, bookmarkId: string, tsMs: number): string {
  return `snapshots/${userId}/${bookmarkId}-${tsMs}.${SNAPSHOT_EXT}`;
}

/** Extracts the capture timestamp from a versioned snapshot key (or 0). */
export function snapshotTimestamp(key: string): number {
  const m = /\/([\w-]+)-(\d+)\.webp$/.exec(key);
  return m ? Number(m[2]) || 0 : 0;
}

/** Sorts retained snapshot keys newest-first (largest timestamp first). */
export function sortSnapshotsNewestFirst(keys: string[]): string[] {
  return [...keys].sort((a, b) => snapshotTimestamp(b) - snapshotTimestamp(a));
}

/** Content type used both when storing and when serving. */
export function snapshotContentType(): string {
  return 'image/webp';
}

/**
 * Path a browser uses to fetch a specific snapshot image (unauthenticated GET).
 * The key is the full object path and doubles as the access token. The endpoint
 * serves the object without ownership re-check (fail-closed auth allowlist for
 * `/api/snapshots/` is enforced by the middleware).
 */
export function snapshotServePath(key: string): string {
  return `/api/snapshots/${encodeURIComponent(key)}`;
}

/**
 * Produces the retained snapshot list after appending a newly captured key,
 * honouring the retention limit (`limit < 0` = unlimited). Returns both the
 * keys to keep (oldest → newest) and the keys that must be deleted from R2.
 *
 * Pure function — no I/O — so the retention policy is unit-testable.
 */
export function planRetention(
  existing: string[],
  newKey: string,
  limit: number,
): { keep: string[]; drop: string[] } {
  const all = [...existing, newKey];
  if (limit < 0 || all.length <= limit) return { keep: all, drop: [] };
  const sorted = sortSnapshotsNewestFirst(all);
  const keep = sorted.slice(0, limit).reverse(); // restore oldest→newest order
  const dropped = new Set(sorted.slice(limit).map((k) => k));
  return { keep, drop: [...dropped] };
}

/**
 * Calls the configured third-party screenshot API for `targetUrl`.
 *
 * Resolves to the image bytes + content type, or throws an ApiException
 * describing exactly why (so the caller can map it to the right user message).
 */
export async function fetchSnapshotFromApi(
  targetUrl: string,
  opts: {
    apiUrl?: string;
    apiKey?: string;
    userAgent?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { apiUrl: configuredUrl, apiKey, fetchFn = fetch, timeoutMs = SNAPSHOT_FETCH_TIMEOUT_MS } = opts;

  if (!configuredUrl) {
    throw new Error('SNAPSHOT_API_URL 未配置，无法用外部服务生成网站快照');
  }
  const apiUrl = configuredUrl;

  // Support both a plain base URL and one that takes the target as a token.
  const url = apiUrl.includes('{url}') ? apiUrl.replace('{url}', encodeURIComponent(targetUrl)) : apiUrl;
  // A realistic browser User-Agent greatly improves success with free / no-key
  // screenshot services, many of which reject the default Workers UA (or empty
  // UA) as a bot / datacenter request and answer with 401. Overridable via the
  // `userAgent` opt (e.g. a provider that requires a registered agent string).
  const headers: Record<string, string> = {
    accept: 'image/webp, image/png, image/jpeg, */*',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (opts.userAgent) headers['user-agent'] = opts.userAgent;

  // One signal covers the handshake AND the body read: an API that answers
  // 200 and then stalls mid-image is just as damaging as one that never
  // answers at all.
  const signal = AbortSignal.timeout(timeoutMs);

  const received = await (async () => {
    try {
      const res = await fetchFn(url, { headers, redirect: 'follow', signal });
      if (!res.ok) {
        throw new Error(`截图服务返回 ${res.status} ${res.statusText}`);
      }
      return {
        buf: new Uint8Array(await res.arrayBuffer()),
        rawContentType: res.headers.get('content-type'),
      };
    } catch (e) {
      if (isAbortError(e)) {
        throw new Error(`截图服务在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`);
      }
      throw e;
    }
  })();

  const { buf } = received;
  if (buf.byteLength === 0) {
    throw new Error('截图服务返回了空响应');
  }
  if (buf.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('截图服务返回的图片过大');
  }

  const contentType = received.rawContentType?.split(';')[0].trim() || snapshotContentType();
  return { bytes: buf, contentType };
}

/** True for both `AbortSignal.timeout` (TimeoutError) and manual aborts. */
function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'TimeoutError' || e.name === 'AbortError';
}

/**
 * Captures a screenshot of `targetUrl` with Cloudflare Browser Run via the
 * `BROWSER` binding (`env.BROWSER.quickAction("screenshot", …)`). Runs on
 * Cloudflare's own network — no external API, no API key, and no risk of the
 * datacenter-IP bans that affect free screenshot APIs.
 *
 * Requires the `BROWSER` binding (browser binding in wrangler.toml) and a
 * compatibility_date >= 2026-03-24. `quickAction` returns a Response whose body
 * is the image; we validate non-empty and byte-size like the external path so
 * the downstream size guard is uniform.
 */
export async function captureWithBrowserRun(
  env: Pick<Env, 'BROWSER'>,
  targetUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!env.BROWSER) {
    throw new Error('BROWSER (Browser Run) 未绑定，无法生成网站快照');
  }
  // `quickAction("screenshot", { url, screenshotOptions })` on the browser
  // binding (Cloudflare Browser Run) renders the page and returns the image.
  const res = await env.BROWSER.quickAction('screenshot', {
    url: targetUrl,
    screenshotOptions: {},
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error('截图服务返回了空响应');
  }
  if (buf.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('截图服务返回的图片过大');
  }
  const contentType =
    res.headers.get('content-type')?.split(';')[0].trim() || snapshotContentType();
  return { bytes: buf, contentType };
}

/**
 * Stores raw image bytes into the bucket under a versioned key for the
 * bookmark, returning the object key the caller should persist. Each call
 * writes a NEW object (timestamp-suffixed), so calling it repeatedly keeps a
 * distinct capture per invocation rather than overwriting the previous one.
 */
export async function putSnapshot(
  env: Pick<Env, 'SNAPSHOT_BUCKET'>,
  userId: string,
  bookmarkId: string,
  bytes: Uint8Array,
  contentType: string,
  tsMs: number = Date.now(),
): Promise<string> {
  if (!env.SNAPSHOT_BUCKET) {
    throw new Error('SNAPSHOT_BUCKET 未绑定，无法存储网站快照');
  }
  const key = snapshotObjectKey(userId, bookmarkId, tsMs);
  await env.SNAPSHOT_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  return key;
}

/** Deletes one or more stored snapshot objects by key. Best-effort helper. */
export async function deleteSnapshots(
  env: Pick<Env, 'SNAPSHOT_BUCKET'>,
  keys: string | string[],
): Promise<void> {
  if (!env.SNAPSHOT_BUCKET || keys.length === 0) return;
  await env.SNAPSHOT_BUCKET.delete(keys);
}

/**
 * Stores a captured image as a new versioned snapshot and applies the
 * retention policy: returns the new object key and the retention decision
 * (which keys to keep — including the new one — and which oldest ones to drop).
 *
 * Pure over the R2 write; the caller owns the DB update (persist `keep` as
 * `snapshot_keys` + the new key as `snapshot_key`, and delete `drop` via
 * `deleteSnapshots`). Kept separate from the DB so it stays unit-testable.
 */
export async function storeSnapshotWithRetention(
  env: Pick<Env, 'SNAPSHOT_BUCKET'>,
  opts: {
    userId: string;
    bookmarkId: string;
    existingKeys: string[];
    bytes: Uint8Array;
    contentType: string;
    retentionLimit: number;
    tsMs?: number;
  },
): Promise<{ key: string; keep: string[]; drop: string[] }> {
  const { userId, bookmarkId, existingKeys, bytes, contentType, retentionLimit, tsMs } = opts;
  const key = await putSnapshot(env, userId, bookmarkId, bytes, contentType, tsMs);
  return { key, ...planRetention(existingKeys, key, retentionLimit) };
}

/** Fetches the stored object bytes for a key, or null when absent. */
export async function getSnapshot(
  env: Pick<Env, 'SNAPSHOT_BUCKET'>,
  key: string,
): Promise<R2ObjectBody | null> {
  if (!env.SNAPSHOT_BUCKET) return null;
  return env.SNAPSHOT_BUCKET.get(key);
}

/**
 * Friendly error message for the front end, grouped by failure mode so the API
 * and UI need not parse exception strings.
 */
export type SnapshotErrorKind =
  | 'not_configured' // no SNAPSHOT_API_URL
  | 'provider_error' // third-party service failed / non-2xx
  | 'too_large'
  | 'empty'
  | 'r2_unavailable'; // bucket missing / write failed

interface CaptureAndStoreResult {
  key: string;
  keep: string[];
  drop: string[];
}

/**
 * End-to-end capture for a single bookmark: resolves the provider, renders the
 * screenshot, stores it in R2 with retention, and returns the new key plus the
 * retained key list. This is the shared body used by both the per-bookmark
 * snapshot endpoint and the real-time monitor refresh endpoint.
 */
export async function captureAndStoreBookmarkSnapshot(
  env: Pick<Env, 'SNAPSHOT_BUCKET' | 'SNAPSHOT_API_URL' | 'SNAPSHOT_API_KEY' | 'BROWSER'>,
  opts: {
    userId: string;
    bookmarkId: string;
    url: string;
    existingKeys: string[];
    retentionLimit: number;
  },
): Promise<CaptureAndStoreResult> {
  if (!env.SNAPSHOT_BUCKET) {
    throw new Error('SNAPSHOT_BUCKET 未绑定，无法存储网站快照');
  }

  const provider = resolveSnapshotProvider(env);
  if (provider === 'none') {
    throw new Error('未配置截图能力（需启用 Cloudflare Browser Run 或设置 SNAPSHOT_API_URL）');
  }

  let bytes: Uint8Array;
  let contentType: string;
  try {
    if (provider === 'external') {
      ({ bytes, contentType } = await fetchSnapshotFromApi(opts.url, {
        apiUrl: env.SNAPSHOT_API_URL,
        apiKey: env.SNAPSHOT_API_KEY,
      }));
    } else {
      ({ bytes, contentType } = await captureWithBrowserRun(env, opts.url));
    }
  } catch (e) {
    const { message } = classifySnapshotError(e);
    throw new Error(message);
  }

  const stored = await storeSnapshotWithRetention(env, {
    userId: opts.userId,
    bookmarkId: opts.bookmarkId,
    existingKeys: opts.existingKeys,
    bytes,
    contentType,
    retentionLimit: opts.retentionLimit,
  });
  return stored;
}

export function classifySnapshotError(e: unknown): { kind: SnapshotErrorKind; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('SNAPSHOT_API_URL 未配置')) return { kind: 'not_configured', message: '网站快照功能未配置（未设置 SNAPSHOT_API_URL）' };
  if (msg.includes('BROWSER (Browser Run) 未绑定')) return { kind: 'not_configured', message: '网站快照功能未配置（未启用 Cloudflare Browser Run）' };
  if (msg.includes('SNAPSHOT_BUCKET 未绑定')) return { kind: 'r2_unavailable', message: '图片存储服务未配置，请稍后重试' };
  if (msg.includes('没有响应')) return { kind: 'provider_error', message: '截图服务响应超时，请稍后重试' };
  if (msg.includes('空响应')) return { kind: 'empty', message: '截图服务返回了空响应，请稍后重试' };
  if (msg.includes('图片过大')) return { kind: 'too_large', message: '截图服务返回的图片过大，无法存储' };
  return { kind: 'provider_error', message: msg };
}

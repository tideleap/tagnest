import type { Env } from './env';

/**
 * Website snapshots ("website preview image").
 *
 * Pipeline ownership:
 *   1. The backend asks a third-party screenshot API for an image of the
 *      bookmark's URL (the source is intentionally external — see the SNAPSHOT_
 *      env vars in env.ts).
 *   2. The returned bytes are uploaded to an R2 object at
 *      `snapshots/{userId}/{bookmarkId}.{ext}`; the object key is stored on the
 *      bookmark row as `snapshot_key`.
 *   3. The card now serves the FIRST-PARTY image via the snapshot endpoint
 *      instead of the raw remote `coverUrl`.
 *
 * Every function is pure over its `Env` + injectable `fetch` so the unit tests
 * can exercise the whole flow with an in-memory R2 stub and a mocked remote.
 */

export const SNAPSHOT_EXT = 'webp';

/** Max bytes accepted from a third-party snapshot service (≈ 4 MB). */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/**
 * Default snapshot provider used when SNAPSHOT_API_URL is not configured on an
 * instance. Points at a no-key service that answers a GET with the raw image
 * bytes (`image/webp`), which is exactly what `fetchSnapshotFromApi` expects.
 *
 * This is a best-effort ON-BY-DEFAULT fallback so snapshots work out of the
 * box on a fresh deploy. Operators who want a governed provider — or none at
 * all — should set `SNAPSHOT_API_URL` explicitly (an explicit value always
 * wins). To disable the default while leaving the feature otherwise armed via
 * `SNAPSHOT_API_URL`, simply configure your own value.
 */
export const DEFAULT_SNAPSHOT_API_URL =
  'https://api.sitelookeratter.com/screenshot?url={url}&format=webp&device=desktop';

/**
 * Resolves the provider URL to call, honouring an explicit SNAPSHOT_API_URL
 * first and falling back to the built-in free default. `null` only when the
 * caller explicitly disabled the default by passing an empty string.
 */
export function resolveSnapshotApiUrl(configured?: string): string | null {
  if (configured) return configured;
  return DEFAULT_SNAPSHOT_API_URL;
}

function snapshotObjectKey(userId: string, bookmarkId: string): string {
  return `snapshots/${userId}/${bookmarkId}.${SNAPSHOT_EXT}`;
}

/** Content type used both when storing and when serving. */
export function snapshotContentType(): string {
  return 'image/webp';
}

/**
 * Path a browser uses to fetch the snapshot image (unauthenticated GET). The
 * endpoint resolves the key to an object by its userId/owner and serves it.
 */
export function snapshotServePath(userId: string, bookmarkId: string): string {
  const key = snapshotObjectKey(userId, bookmarkId);
  return `/api/snapshots/${encodeURIComponent(key)}`;
}

/**
 * Calls the configured third-party screenshot API for `targetUrl`.
 *
 * Resolves to the image bytes + content type, or throws an ApiException
 * describing exactly why (so the caller can map it to the right user message).
 */
export async function fetchSnapshotFromApi(
  targetUrl: string,
  opts: { apiUrl?: string; apiKey?: string; fetchFn?: typeof fetch },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { apiUrl: configuredUrl, apiKey, fetchFn = fetch } = opts;

  const apiUrl = resolveSnapshotApiUrl(configuredUrl);
  if (!apiUrl) {
    throw new Error('SNAPSHOT_API_URL 未配置，无法生成网站快照');
  }

  // Support both a plain base URL and one that takes the target as a token.
  const url = apiUrl.includes('{url}') ? apiUrl.replace('{url}', encodeURIComponent(targetUrl)) : apiUrl;
  const headers: Record<string, string> = {
    accept: 'image/webp, image/png, image/jpeg, */*',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetchFn(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`截图服务返回 ${res.status} ${res.statusText}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error('截图服务返回了空响应');
  }
  if (buf.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('截图服务返回的图片过大');
  }

  const contentType = res.headers.get('content-type')?.split(';')[0].trim() || snapshotContentType();
  return { bytes: buf, contentType };
}

/**
 * Stores raw image bytes into the bucket under the bookmark's key.
 * Returns the object key so the caller can persist it as `snapshot_key`.
 */
export async function putSnapshot(
  env: Pick<Env, 'SNAPSHOT_BUCKET'>,
  userId: string,
  bookmarkId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  if (!env.SNAPSHOT_BUCKET) {
    throw new Error('SNAPSHOT_BUCKET 未绑定，无法存储网站快照');
  }
  const key = snapshotObjectKey(userId, bookmarkId);
  await env.SNAPSHOT_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  return key;
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

export function classifySnapshotError(e: unknown): { kind: SnapshotErrorKind; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('SNAPSHOT_API_URL 未配置')) return { kind: 'not_configured', message: '网站快照功能未配置，无法生成预览图' };
  if (msg.includes('空响应')) return { kind: 'empty', message: '截图服务返回了空响应，请稍后重试' };
  if (msg.includes('图片过大')) return { kind: 'too_large', message: '截图服务返回的图片过大，无法存储' };
  if (msg.includes('未绑定')) return { kind: 'r2_unavailable', message: '图片存储服务暂不可用，请稍后重试' };
  return { kind: 'provider_error', message: msg };
}

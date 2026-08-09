/**
 * Snapshot serve-key encoding.
 *
 * R2 object keys contain slashes, e.g. `snapshots/{userId}/{bookmarkId}-{ts}.webp`.
 * Putting that raw into a URL path (`/api/snapshots/snapshots/...`) splits the
 * key across multiple route segments and 404s — Cloudflare matches the first
 * segment only. We instead encode the *whole* key as a single base64url segment
 * so the `/api/snapshots/[key]` route receives it intact and decodes it back.
 *
 * base64url is path-safe (A-Za-z0-9-_ with no padding), so the encoded value
 * never introduces a slash and always lands as one route parameter.
 *
 * These helpers are intentionally dependency-free so they can run in both the
 * Cloudflare Worker (Node-ish, has Buffer) and the browser (has btoa/atob).
 */

// `Buffer` exists in the Workers runtime but not in the browser; we read it off
// `globalThis` with a loose cast so the frontend build (no @types/node) still
// type-checks. The browser branch uses the native btoa/atob pair.
type BufferLike = {
  from(input: string, encoding: string): { toString(encoding: string): string };
};
function getBuffer(): BufferLike | undefined {
  return (globalThis as unknown as { Buffer?: BufferLike }).Buffer;
}

function toBase64Url(input: string): string {
  const buf = getBuffer();
  if (buf) {
    return buf.from(input, 'utf8').toString('base64url');
  }
  const b64 = btoa(unescape(encodeURIComponent(input)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(token: string): string {
  const buf = getBuffer();
  if (buf) {
    return buf.from(token, 'base64url').toString('utf8');
  }
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b64)));
}

/** Encode a full R2 object key into a single URL-safe segment. */
export function encodeSnapshotKey(key: string): string {
  return toBase64Url(key);
}

/** Decode a URL-safe segment back into the full R2 object key. */
export function decodeSnapshotKey(token: string): string {
  return fromBase64Url(token);
}

/** Build the unauthenticated image path for a snapshot key. */
export function snapshotServePath(key: string): string {
  return `/api/snapshots/${encodeSnapshotKey(key)}`;
}

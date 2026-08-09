import { describe, expect, it } from 'vitest';
import { onRequestGet } from '../functions/api/snapshots/[key]';
import { putSnapshot } from '../functions/_lib/snapshots';
import { encodeSnapshotKey } from '../shared/snapshotUrl';

function memR2() {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { body: new Uint8Array(value), contentType: opts?.httpMetadata?.contentType ?? 'image/webp' });
      return {} as R2Object;
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      const hit = store.get(key);
      if (!hit) return null;
      return { body: asStream(hit.body), httpMetadata: { contentType: hit.contentType } } as R2ObjectBody;
    },
  };
}
function asStream(bytes: Uint8Array): ReadableStream {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

describe('GET /api/snapshots/[key]', () => {
  it('decodes the base64url token and streams the stored R2 object as an image', async () => {
    const bucket = memR2();
    const env = { SNAPSHOT_BUCKET: bucket } as unknown as Parameters<typeof onRequestGet>[0]['env'];
    const key = await putSnapshot(env, 'user_x', 'bookmark_y', new Uint8Array([1, 2, 3, 4, 5]), 'image/webp', 1234);

    const token = encodeSnapshotKey(key);
    // The token must be a single path segment (no slashes) so the route gets it whole.
    expect(token).not.toContain('/');

    const ctx = { params: { key: token }, env } as unknown as Parameters<typeof onRequestGet>[0];
    const res = await onRequestGet(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('Cache-Control')).toContain('max-age=31536000');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5]);
  });

  it('404s on a token that decodes to a non-matching key', async () => {
    const env = { SNAPSHOT_BUCKET: memR2() } as unknown as Parameters<typeof onRequestGet>[0]['env'];
    const ctx = { params: { key: encodeSnapshotKey('totally/not-a-snapshot.webp') }, env } as unknown as Parameters<typeof onRequestGet>[0];
    // notFound() throws; the middleware turns it into a 404 response.
    await expect(onRequestGet(ctx)).rejects.toMatchObject({ status: 404 });
  });
});

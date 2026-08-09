import type { Env, RequestData } from '../../_lib/env';
import { notFound } from '../../_lib/http';
import { getSnapshot, snapshotContentType } from '../../_lib/snapshots';
import { decodeSnapshotKey } from '../../../shared/snapshotUrl';

/**
 * GET /api/snapshots/:key
 *
 * Streams a stored website-snapshot object back with an aggressive cache header
 * so repeated card renders hit the edge/browser cache instead of R2. The `:key`
 * route param is a base64url-encoded R2 object key
 * (`snapshots/{userId}/{bookmarkId}-{ts}.webp`) — encoding keeps the slashes out
 * of the URL path so the route always receives the whole key as one segment.
 */
const KEY_PATTERN = /^snapshots\/[\w-]+\/[\w-]+(?:-\d+)?\.webp$/;

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const raw = ctx.params.key as string;

  // The URL segment is a base64url token of the full R2 key (no slashes).
  let key: string;
  try {
    key = decodeSnapshotKey(String(raw));
  } catch {
    throw notFound('快照不存在');
  }
  if (!KEY_PATTERN.test(key)) {
    throw notFound('快照不存在');
  }

  const object = await getSnapshot(ctx.env, key);
  if (!object) throw notFound('快照不存在');

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? snapshotContentType());
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('CDN-Cache-Control', 'public, max-age=31536000');

  return new Response(object.body, { headers });
};

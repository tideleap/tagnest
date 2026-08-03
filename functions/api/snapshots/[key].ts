import type { Env, RequestData } from '../../_lib/env';
import { notFound } from '../../_lib/http';
import { getSnapshot, snapshotContentType } from '../../_lib/snapshots';

/**
 * GET /api/snapshots/:key
 *
 * Streams a stored website-snapshot object back with an aggressive cache header
 * so repeated card renders hit the edge/browser cache instead of R2. The key
 * is the full object path (`snapshots/{userId}/{bookmarkId}-{ts}.webp`) and
 * doubles as the access token; a valid key implies a legitimately generated
 * snapshot.
 */
const KEY_PATTERN = /^snapshots\/[\w-]+\/[\w-]+(?:-\d+)?\.webp$/;

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const raw = ctx.params.key as string;

  const key = decodeURIComponent(Array.isArray(raw) ? raw[0] : String(raw));
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

import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { D1_IN_CHUNK, ensureTags } from '../../_lib/db';
import { readIds } from './trash';

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);
  const ids = readIds(body);

  const addNames = Array.isArray(body.addTagNames)
    ? (body.addTagNames as unknown[]).map(String).slice(0, 30)
    : [];
  const removeIds = Array.isArray(body.removeTagIds)
    ? (body.removeTagIds as unknown[]).map(String).slice(0, 30)
    : [];

  if (addNames.length === 0 && removeIds.length === 0) {
    throw badRequest('未指定要添加或移除的标签');
  }

  // Ownership check up front: without it, a crafted id list could attach the
  // caller's tags to another account's rows.
  const owned = await ctx.env.DB.prepare(
    `SELECT id FROM bookmarks WHERE user_id = ? AND is_private = 0 AND id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(userId, ...ids)
    .all<{ id: string }>();

  const ownedIds = owned.results.map((r) => r.id);
  if (ownedIds.length === 0) return json({ updated: 0 });

  const statements: D1PreparedStatement[] = [];

  if (addNames.length > 0) {
    const { ids: tagIds } = await ensureTags(ctx.env, userId, addNames);
    for (const bookmarkId of ownedIds) {
      for (const tagId of tagIds) {
        statements.push(
          ctx.env.DB.prepare(
            `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)`,
          ).bind(bookmarkId, tagId),
        );
      }
    }
  }

  if (removeIds.length > 0) {
    // D1 caps bound params at 100/statement. Removing a tag from many bookmarks
    // means `bookmark_id IN (...) AND tag_id = ?`; chunk the bookmark list so
    // each DELETE stays `<= D1_IN_CHUNK + 1` params (the tag id).
    for (const tagId of removeIds) {
      for (let i = 0; i < ownedIds.length; i += Math.min(D1_IN_CHUNK - 1, ownedIds.length)) {
        const slice = ownedIds.slice(i, i + D1_IN_CHUNK - 1);
        if (slice.length === 0) break;
        const idsPh = slice.map(() => '?').join(',');
        statements.push(
          ctx.env.DB.prepare(
            `DELETE FROM bookmark_tags
              WHERE bookmark_id IN (${idsPh}) AND tag_id = ?`,
          ).bind(...slice, tagId),
        );
      }
    }
  }

  // A single `batch()` is capped at 100 statements, and this handler can build
  // hundreds (add N tags to M bookmarks, or remove across many rows) — plus the
  // updated_at bump, whose IN-list must also stay within 100 bound params.
  const ts = nowIso();
  for (let i = 0; i < ownedIds.length; i += D1_IN_CHUNK - 2) {
    const slice = ownedIds.slice(i, i + D1_IN_CHUNK - 2);
    statements.push(
      ctx.env.DB.prepare(
        `UPDATE bookmarks SET updated_at = ?
          WHERE user_id = ? AND id IN (${slice.map(() => '?').join(',')})`,
      ).bind(ts, userId, ...slice),
    );
  }

  // Flush in groups of 90 so we never trip D1's 100-statement batch cap.
  const BATCH_LIMIT = 90;
  for (let i = 0; i < statements.length; i += BATCH_LIMIT) {
    await ctx.env.DB.batch(statements.slice(i, i + BATCH_LIMIT));
  }

  return json({ updated: ownedIds.length });
};

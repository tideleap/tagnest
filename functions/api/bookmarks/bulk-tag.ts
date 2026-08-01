import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { ensureTags } from '../../_lib/db';
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
    `SELECT id FROM bookmarks WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
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
    statements.push(
      ctx.env.DB.prepare(
        `DELETE FROM bookmark_tags
          WHERE bookmark_id IN (${ownedIds.map(() => '?').join(',')})
            AND tag_id IN (${removeIds.map(() => '?').join(',')})`,
      ).bind(...ownedIds, ...removeIds),
    );
  }

  statements.push(
    ctx.env.DB.prepare(
      `UPDATE bookmarks SET updated_at = ?
        WHERE user_id = ? AND id IN (${ownedIds.map(() => '?').join(',')})`,
    ).bind(nowIso(), userId, ...ownedIds),
  );

  // D1 batches run in a single transaction, so a partially tagged selection
  // is not a state the client can observe.
  await ctx.env.DB.batch(statements);

  return json({ updated: ownedIds.length });
};

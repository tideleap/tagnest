import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, notFound, readJson } from '../../_lib/http';

/**
 * Folds one or more tags into a target.
 *
 * Cleaning up an import that produced "js", "JS" and "javascript" is the
 * common case, and doing it by hand means re-tagging every affected bookmark.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ sourceIds?: unknown; targetId?: unknown }>(ctx.request);

  const targetId = String(body.targetId ?? '');
  if (!targetId) throw badRequest('请选择目标标签');

  const sourceIds = Array.isArray(body.sourceIds)
    ? [...new Set(body.sourceIds.map(String))].filter((id) => id && id !== targetId).slice(0, 50)
    : [];
  if (sourceIds.length === 0) throw badRequest('请选择要合并的标签');

  const target = await ctx.env.DB.prepare(
    `SELECT id FROM tags WHERE id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(targetId, userId)
    .first<{ id: string }>();
  if (!target) throw notFound('目标标签不存在');

  const ph = sourceIds.map(() => '?').join(',');

  await ctx.env.DB.batch([
    // Repoint every link, ignoring rows that would collide with an existing
    // (bookmark, target) pair.
    ctx.env.DB.prepare(
      `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id)
       SELECT bt.bookmark_id, ?
         FROM bookmark_tags bt
         JOIN tags t ON t.id = bt.tag_id
        WHERE t.user_id = ? AND bt.tag_id IN (${ph})`,
    ).bind(targetId, userId, ...sourceIds),

    // Cascade on tags removes the leftover source links.
    ctx.env.DB.prepare(`DELETE FROM tags WHERE user_id = ? AND id IN (${ph})`).bind(
      userId,
      ...sourceIds,
    ),
  ]);

  return json({ merged: sourceIds.length });
};

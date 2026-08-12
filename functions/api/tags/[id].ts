import { TAG_COLOR_COUNT } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, noContent, notFound, readJson } from '../../_lib/http';
import { mapTag, setTagPrivate } from '../../_lib/db';

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const current = await ctx.env.DB.prepare(
    `SELECT id, name, color_index, parent_id, sort_order, created_at
       FROM tags WHERE id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(id, userId)
    .first<Record<string, unknown>>();
  if (!current) throw notFound('标签不存在');

  const body = await readJson<{
    name?: string;
    colorIndex?: number;
    parentId?: string | null;
    isPrivate?: boolean;
  }>(ctx.request);

  const sets: string[] = [];
  const params: unknown[] = [];

  if (typeof body.name === 'string') {
    const name = body.name.trim().replace(/\s+/g, ' ');
    if (!name) throw badRequest('请输入标签名', { name: '请输入标签名' });

    const clash = await ctx.env.DB.prepare(
      `SELECT id FROM tags WHERE user_id = ? AND name COLLATE NOCASE = ? AND id <> ? LIMIT 1`,
    )
      .bind(userId, name, id)
      .first<{ id: string }>();
    if (clash) throw conflict('已存在同名标签', { name: '已存在同名标签' });

    sets.push('name = ?');
    params.push(name.slice(0, 60));
  }

  if (Number.isInteger(body.colorIndex)) {
    sets.push('color_index = ?');
    params.push(Math.abs(body.colorIndex as number) % TAG_COLOR_COUNT);
  }

  if ('parentId' in body) {
    // Self-parenting would produce a cycle the tree renderer cannot escape.
    if (body.parentId === id) throw badRequest('标签不能作为自己的父级');
    sets.push('parent_id = ?');
    params.push(body.parentId ?? null);
  }

  if (sets.length > 0) {
    params.push(id, userId);
    await ctx.env.DB.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...params)
      .run();
  }

  // Category privacy cascades to the whole subtree (parent + every descendant)
  // in one statement; visibility is derived in SQL so no bookmark is rewritten.
  if (typeof body.isPrivate === 'boolean') {
    await setTagPrivate(ctx.env, userId, id, body.isPrivate);
  }

  const updated = await ctx.env.DB.prepare(
    `SELECT t.id, t.name, t.color_index, t.parent_id, t.sort_order, t.is_private,
            t.created_at, COUNT(b.id) AS count
       FROM tags t
       LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
       LEFT JOIN bookmarks b ON b.id = bt.bookmark_id AND b.deleted_at IS NULL
      WHERE t.id = ? AND t.user_id = ?
      GROUP BY t.id`,
  )
    .bind(id, userId)
    .first<Record<string, unknown>>();

  if (!updated) throw notFound('标签不存在');
  return json(mapTag(updated));
};

/** Removes the tag only; the bookmarks carrying it are left alone. */
export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const result = await ctx.env.DB.prepare(`DELETE FROM tags WHERE id = ? AND user_id = ?`)
    .bind(String(ctx.params.id), userId)
    .run();

  if (!result.meta.changes) throw notFound('标签不存在');
  return noContent();
};

import { TAG_COLOR_COUNT } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, readJson } from '../../_lib/http';
import { newId, nowIso } from '../../_lib/ids';
import { colorForName, mapTag } from '../../_lib/db';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  // LEFT JOIN keeps zero-use tags in the list; the tags page needs them in
  // order to offer cleanup of unused entries.
  const rows = await ctx.env.DB.prepare(
    `SELECT t.id, t.name, t.color_index, t.parent_id, t.sort_order, t.is_private,
            t.created_at, COUNT(b.id) AS count
       FROM tags t
       LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
       LEFT JOIN bookmarks b ON b.id = bt.bookmark_id AND b.deleted_at IS NULL
      WHERE t.user_id = ?
      GROUP BY t.id
      ORDER BY t.sort_order, t.name COLLATE NOCASE`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();

  return json(rows.results.map(mapTag));
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ name?: string; colorIndex?: number; parentId?: string | null }>(
    ctx.request,
  );

  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('请输入标签名', { name: '请输入标签名' });
  if (name.length > 60) throw badRequest('标签名过长', { name: '标签名不能超过 60 个字符' });

  const existing = await ctx.env.DB.prepare(
    `SELECT id FROM tags WHERE user_id = ? AND name COLLATE NOCASE = ? LIMIT 1`,
  )
    .bind(userId, name)
    .first<{ id: string }>();
  if (existing) throw conflict('标签已存在', { name: '标签已存在' });

  const colorIndex =
    Number.isInteger(body.colorIndex) && (body.colorIndex as number) >= 0
      ? (body.colorIndex as number) % TAG_COLOR_COUNT
      : colorForName(name);

  const id = newId();
  const ts = nowIso();

  await ctx.env.DB.prepare(
    `INSERT INTO tags (id, user_id, name, color_index, parent_id, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(id, userId, name, colorIndex, body.parentId ?? null, ts)
    .run();

  return json(
    mapTag({
      id,
      name,
      color_index: colorIndex,
      parent_id: body.parentId ?? null,
      sort_order: 0,
      count: 0,
      created_at: ts,
    }),
    { status: 201 },
  );
};

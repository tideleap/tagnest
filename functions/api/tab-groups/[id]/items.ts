import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, readJson } from '../../../_lib/http';
import { addItem, reorderItems } from '../../../_lib/tabgroups';

const MAX_ITEMS = 500;

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const groupId = String(ctx.params.id);
  const body = await readJson<{ bookmarkId?: unknown }>(ctx.request);

  if (typeof body.bookmarkId !== 'string' || !body.bookmarkId) {
    throw badRequest('bookmarkId 必须是字符串');
  }

  // Bounded just like the bookmark reorder: a pathological client cannot pin
  // the worker with an unbounded write loop.
  const count = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM tab_items WHERE group_id = ? AND user_id = ?`,
  )
    .bind(groupId, userId)
    .first<{ c: number }>();
  if ((count?.c ?? 0) >= MAX_ITEMS) throw badRequest(`分组最多包含 ${MAX_ITEMS} 个书签`);

  const item = await addItem(ctx.env, userId, groupId, body.bookmarkId);
  if (!item) throw badRequest('书签不存在、已删除或不属于当前账号');
  return json(item, { status: 201 });
};

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const groupId = String(ctx.params.id);
  const body = await readJson<{ ids?: unknown }>(ctx.request);

  if (!Array.isArray(body.ids)) throw badRequest('ids 必须是数组');
  const ids = [...new Set(body.ids.map((v) => String(v)).filter(Boolean))];
  if (ids.length === 0) throw badRequest('ids 不能为空');

  const reordered = await reorderItems(ctx.env, userId, groupId, ids);
  return json({ reordered });
};

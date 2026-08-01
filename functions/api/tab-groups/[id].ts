import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import { deleteGroup, getGroupWithItems, renameGroup } from '../../_lib/tabgroups';
import { normalizeColorIndex, validateGroupName } from '../../_lib/tabgroups';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const groupId = String(ctx.params.id);
  const result = await getGroupWithItems(ctx.env, userId, groupId);
  if (!result) throw badRequest('分组不存在');
  return json(result);
};

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const groupId = String(ctx.params.id);
  const body = await readJson<{ name?: unknown; colorIndex?: unknown }>(ctx.request);

  const patch: { name?: string; colorIndex?: number } = {};
  if (body.name !== undefined) patch.name = validateGroupName(body.name);
  if (body.colorIndex !== undefined) {
    const c = normalizeColorIndex(body.colorIndex);
    if (c === 0 && body.colorIndex !== 0) throw badRequest('颜色取值无效');
    patch.colorIndex = c;
  }

  const updated = await renameGroup(ctx.env, userId, groupId, patch);
  if (!updated) throw badRequest('分组不存在');
  return json(updated);
};

export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const groupId = String(ctx.params.id);
  const ok = await deleteGroup(ctx.env, userId, groupId);
  if (!ok) throw badRequest('分组不存在');
  return new Response(null, { status: 204 });
};

import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import {
  createGroup,
  listGroups,
  normalizeColorIndex,
  validateGroupName,
} from '../../_lib/tabgroups';
import { colorForName } from '../../_lib/db';
import { createLogger } from '../../_lib/logger';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const groups = await listGroups(ctx.env, userId);
  return json({ items: groups, total: groups.length });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ name?: unknown; colorIndex?: unknown }>(ctx.request);

  const name = validateGroupName(body.name);
  // A colour is optional; when omitted we derive a stable one from the name so
  // groups are visually distinguishable without forcing a colour picker.
  const colorIndex =
    body.colorIndex === undefined ? colorForName(name) : normalizeColorIndex(body.colorIndex);
  if (typeof body.colorIndex !== 'undefined' && colorIndex === 0 && body.colorIndex !== 0) {
    throw badRequest('颜色取值无效');
  }

  const group = await createGroup(ctx.env, userId, name, colorIndex);
  createLogger(ctx.env).info('tab_group.create', { userId, groupId: group.id });
  return json(group, { status: 201 });
};

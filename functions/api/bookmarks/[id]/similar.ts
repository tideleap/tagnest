import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { badRequest, json, notFound } from '../../../_lib/http';
import { similarBookmarks } from '../../../_lib/db';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const raw = new URL(ctx.request.url).searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (raw !== null) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw badRequest('limit 必须为正整数');
    limit = Math.min(Math.floor(n), MAX_LIMIT);
  }

  const result = await similarBookmarks(ctx.env, userId, id, { limit });
  if (!result) throw notFound('书签不存在');

  return json(result);
};

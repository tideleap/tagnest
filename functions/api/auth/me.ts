import type { Env, RequestData } from '../../_lib/env';
import { loadUser, requireUserId } from '../../_lib/auth';
import { json, notFound, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const user = await loadUser(ctx.env, requireUserId(ctx));
  if (!user) throw notFound('账户不存在');
  return json(user);
};

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ displayName?: string; avatarUrl?: string | null }>(ctx.request);

  const sets: string[] = [];
  const params: unknown[] = [];

  if (typeof body.displayName === 'string') {
    const name = body.displayName.trim().slice(0, 60);
    if (name) {
      sets.push('display_name = ?');
      params.push(name);
    }
  }
  if ('avatarUrl' in body) {
    sets.push('avatar_url = ?');
    params.push(body.avatarUrl ? String(body.avatarUrl).slice(0, 500) : null);
  }

  if (sets.length > 0) {
    sets.push('updated_at = ?');
    params.push(nowIso(), userId);
    await ctx.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();
  }

  const user = await loadUser(ctx.env, userId);
  if (!user) throw notFound('账户不存在');
  return json(user);
};

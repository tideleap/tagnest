import type { Env, RequestData } from '../../_lib/env';
import {
  REFRESH_COOKIE,
  loadUser,
  readCookie,
  refreshCookie,
  resolveSession,
  rotateSession,
  signAccessToken,
} from '../../_lib/auth';
import { json, unauthorized } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';

export const onRequestPost: PagesFunction<Env, string, RequestData> = async ({ request, env }) => {
  const token = readCookie(request, REFRESH_COOKIE);
  if (!token) throw unauthorized('尚未登录');

  const userId = await resolveSession(env, token);
  if (!userId) {
    // Clear the stale cookie so the browser stops replaying a dead session.
    return new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: '登录状态已失效，请重新登录' } }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': refreshCookie(request, null),
        },
      },
    );
  }

  const user = await loadUser(env, userId);
  if (!user) throw unauthorized();

  const next = await rotateSession(env, token, userId, request.headers.get('User-Agent'));

  // Cheap opportunistic cleanup — expired rows would otherwise accumulate
  // forever, and a scheduled job is overkill for this volume.
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(nowIso()).run();

  return json(
    { user, accessToken: await signAccessToken(userId, env) },
    { headers: { 'Set-Cookie': refreshCookie(request, next) } },
  );
};

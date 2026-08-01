import type { Env, RequestData } from '../../_lib/env';
import {
  createSession,
  hashPassword,
  mapUser,
  refreshCookie,
  signAccessToken,
  validateCredentials,
} from '../../_lib/auth';
import { ApiException, conflict, json, readJson } from '../../_lib/http';
import { newId, nowIso } from '../../_lib/ids';

export const onRequestPost: PagesFunction<Env, string, RequestData> = async ({ request, env }) => {
  if (env.DISABLE_SIGNUP === 'true') {
    throw new ApiException(403, 'signup_disabled', '该实例已关闭注册');
  }

  const body = await readJson<{ email?: string; password?: string; displayName?: string }>(request);
  const { email, password } = validateCredentials(body.email, body.password);

  const displayName =
    typeof body.displayName === 'string' && body.displayName.trim()
      ? body.displayName.trim().slice(0, 60)
      : email.split('@')[0];

  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE email COLLATE NOCASE = ? LIMIT 1`,
  )
    .bind(email)
    .first<{ id: string }>();

  if (existing) throw conflict('该邮箱已注册', { email: '该邮箱已注册' });

  const id = newId();
  const ts = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, avatar_url, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    ).bind(id, email, displayName, await hashPassword(password, env), ts, ts),
    // Seeded up front so the settings page never has to special-case a missing row.
    env.DB.prepare(
      `INSERT INTO ai_settings (user_id, provider, auto_summarize, auto_tag, enabled, updated_at)
       VALUES (?, 'none', 0, 0, 0, ?)`,
    ).bind(id, ts),
  ]);

  const refresh = await createSession(env, id, request.headers.get('User-Agent'));

  return json(
    {
      user: mapUser({
        id,
        email,
        display_name: displayName,
        avatar_url: null,
        created_at: ts,
      }),
      accessToken: await signAccessToken(id, env),
    },
    { status: 201, headers: { 'Set-Cookie': refreshCookie(request, refresh) } },
  );
};

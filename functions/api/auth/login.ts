import type { Env, RequestData } from '../../_lib/env';
import {
  createSession,
  mapUser,
  refreshCookie,
  signAccessToken,
  validateCredentials,
  verifyPassword,
} from '../../_lib/auth';
import { ApiException, json, readJson } from '../../_lib/http';

export const onRequestPost: PagesFunction<Env, string, RequestData> = async ({ request, env }) => {
  const body = await readJson<{ email?: string; password?: string }>(request);
  const { email, password } = validateCredentials(body.email, body.password);

  const row = await env.DB.prepare(
    `SELECT id, email, display_name, avatar_url, password_hash, created_at
       FROM users WHERE email COLLATE NOCASE = ? LIMIT 1`,
  )
    .bind(email)
    .first<Record<string, unknown>>();

  // One message for both "no such account" and "wrong password". Splitting
  // them turns the login form into an account-existence oracle.
  const invalid = new ApiException(401, 'invalid_credentials', '邮箱或密码不正确');

  if (!row) {
    // Burn comparable CPU on the miss so response time does not reveal
    // whether the address is registered.
    await verifyPassword(password, 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    throw invalid;
  }

  if (!(await verifyPassword(password, row.password_hash as string))) throw invalid;

  const userId = row.id as string;
  const refresh = await createSession(env, userId, request.headers.get('User-Agent'));

  return json(
    { user: mapUser(row), accessToken: await signAccessToken(userId, env) },
    { headers: { 'Set-Cookie': refreshCookie(request, refresh) } },
  );
};

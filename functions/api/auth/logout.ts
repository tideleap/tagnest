import type { Env, RequestData } from '../../_lib/env';
import { REFRESH_COOKIE, readCookie, refreshCookie, revokeSession } from '../../_lib/auth';

export const onRequestPost: PagesFunction<Env, string, RequestData> = async ({ request, env }) => {
  const token = readCookie(request, REFRESH_COOKIE);
  if (token) await revokeSession(env, token);

  // Always 204, even without a cookie: logout is idempotent, and the client
  // must be able to reach a signed-out state regardless of server state.
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': refreshCookie(request, null) },
  });
};

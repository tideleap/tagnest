import type { Env, RequestData } from '../../_lib/env';
import { hashPassword, requireUserId, verifyPassword } from '../../_lib/auth';
import { badRequest, badRequestCode, json, readJson } from '../../_lib/http';
import { nowIso } from '../../_lib/ids';
import { assertNotThrottled, clearFailures, recordFailure } from '../../_lib/throttle';

/**
 * POST /api/auth/password
 *
 * Self-service password change. The user must prove they still know the
 * current password (re-authentication), then we re-hash the new one with the
 * same PBKDF2 parameters as registration. There is no "forgot password" reset
 * here because this instance has no outbound email transport to deliver a
 * reset link — see the report's Non-goals for that branch.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ currentPassword?: string; newPassword?: string }>(ctx.request);

  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (next.length === 0) throw badRequest('请输入新密码', { newPassword: '请输入新密码' });
  if (next.length < 8) throw badRequest('新密码至少 8 位', { newPassword: '新密码至少 8 位' });
  if (next.length > 256) throw badRequest('新密码过长', { newPassword: '新密码过长' });

  const row = await ctx.env.DB.prepare(
    `SELECT email, password_hash FROM users WHERE id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ email: string; password_hash: string | null }>();

  if (!row) throw badRequestCode('account_missing', '账户不存在');

  // A change is a privileged re-auth: gate it behind the same brute-force brake
  // as login so the form can't be used to guess the current password.
  await assertNotThrottled(ctx.env, ctx.request, row.email);

  if (!row.password_hash || !(await verifyPassword(current, row.password_hash))) {
    await recordFailure(ctx.env, ctx.request, row.email);
    throw badRequestCode('current_password_invalid', '当前密码不正确', {
      currentPassword: '当前密码不正确',
    });
  }

  const newHash = await hashPassword(next, ctx.env);
  await ctx.env.DB.prepare(
    `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(newHash, nowIso(), userId)
    .run();

  // Fresh password means old failures shouldn't keep blocking this account.
  await clearFailures(ctx.env, row.email);

  return json({ ok: true });
};

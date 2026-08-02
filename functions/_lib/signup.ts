import type { Env } from './env';
import { ApiException } from './http';

/* ------------------------------------------------------------------ *
 * Email allowlist (open-but-gated registration)
 *
 * The instance keeps registration publicly reachable, but an operator can
 * restrict who may sign up by setting ALLOWED_EMAILS in the environment:
 *
 *   ALLOWED_EMAILS = "alice@example.com, bob@example.com, *@corp.dev"
 *
 * Each entry is either an exact address (case-insensitive) or a domain
 * wildcard ("*@corp.dev" admits anyone @corp.dev). When the value is empty or
 * unset, registration stays fully open — backward compatible with the original
 * behaviour and with DISABLE_SIGNUP=true (which hard-closes it instead).
 * ------------------------------------------------------------------ */

export function assertEmailAllowed(env: Env, email: string): void {
  const raw = env.ALLOWED_EMAILS?.trim();
  if (!raw) return; // open registration

  const lower = email.trim().toLowerCase();
  const rules = raw
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);

  const permitted = rules.some((rule) => {
    if (rule.startsWith('*@')) return lower.endsWith(rule.slice(1));
    return rule === lower;
  });

  if (!permitted) {
    throw new ApiException(403, 'signup_email_not_allowed', '该邮箱不在允许注册名单内');
  }
}

/**
 * Constant-time string comparison. Avoids a length/timing oracle on the invite
 * code: guesses of differing length or prefix should not reveal how close they
 * are to the real secret.
 */
export function constantTimeEq(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * Optional invite-code gate. When INVITE_CODE is set, `provided` must match it
 * exactly (constant-time). An empty/unset code never matches a configured
 * secret, so a blank form cannot bypass the gate. Throws 403 otherwise.
 * No-op when INVITE_CODE is unset.
 */
export function assertInviteCode(env: Env, provided: string | undefined): void {
  const secret = env.INVITE_CODE;
  if (!secret) return;
  const candidate = typeof provided === 'string' ? provided : '';
  if (!candidate || !constantTimeEq(candidate, secret)) {
    throw new ApiException(403, 'signup_invite_required', '需要有效的邀请码');
  }
}

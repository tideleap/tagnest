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

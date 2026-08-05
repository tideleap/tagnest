import { useMutation } from '@tanstack/react-query';
import type { User } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { useAuth } from '@/stores/auth';

export interface MePatch {
  displayName?: string;
  avatarUrl?: string | null;
}

/**
 * PATCH /auth/me — the backend already accepts displayName / avatarUrl, but
 * the settings page only ever rendered them read-only. This wires the edit
 * path back up: on success the in-memory user is patched (so the sidebar and
 * every cached view update instantly) and a toast confirms.
 */
export function useUpdateMe() {
  return useMutation({
    mutationFn: (patch: MePatch) => api.patch<User>('/auth/me', patch),
    onSuccess: (user) => {
      useAuth.getState().patchUser(user);
      toast.success('资料已更新');
    },
    onError: (e: Error) => toast.error('更新失败', e.message),
  });
}

/**
 * POST /auth/password — change the signed-in user's password after proving the
 * current one. Self-service only; a reset-without-login flow would need an
 * outbound email transport this instance does not have.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api.post<{ ok: true }>('/auth/password', input),
    onSuccess: () => toast.success('密码已修改'),
    onError: (e: Error) => toast.error('修改失败', e.message),
  });
}

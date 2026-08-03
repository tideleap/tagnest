import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserSettings } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

export function useUserSettings() {
  return useQuery({
    queryKey: keys.userSettings,
    queryFn: () => api.get<UserSettings>('/settings'),
    staleTime: 5 * 60_000,
  });
}

export function useUpdateUserSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<UserSettings>) => api.put<UserSettings>('/settings', patch),
    onSuccess: (next) => {
      qc.setQueryData(keys.userSettings, next);
      toast.success('设置已保存');
    },
    onError: (e: Error) => toast.error('保存失败', e.message),
  });
}

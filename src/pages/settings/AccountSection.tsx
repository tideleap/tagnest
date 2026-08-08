import { useEffect, useState, type FormEvent } from 'react';
import { User as UserIcon } from 'lucide-react';
import { Button, Input, RemoteImage, Skeleton } from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { useStats } from '@/hooks/queries';
import { useChangePassword, useUpdateMe, type MePatch } from '@/hooks/queries/auth';
import { Card } from './Card';

export function AccountSection() {
  const user = useAuth((s) => s.user);
  const { data: stats, isLoading } = useStats();
  const updateMe = useUpdateMe();
  const changePw = useChangePassword();

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? '');

  // Re-sync the form whenever the underlying user record changes — covers a
  // fresh bootstrap as well as the store patch we perform after a save.
  useEffect(() => {
    setDisplayName(user?.displayName ?? '');
    setAvatarUrl(user?.avatarUrl ?? '');
  }, [user?.id, user?.displayName, user?.avatarUrl]);

  const dirty =
    displayName.trim() !== (user?.displayName ?? '') ||
    avatarUrl.trim() !== (user?.avatarUrl ?? '');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const patch: MePatch = {};
    const name = displayName.trim();
    if (name && name !== user?.displayName) patch.displayName = name.slice(0, 60);
    const url = avatarUrl.trim();
    const next = url === '' ? null : url.slice(0, 500);
    if (next !== (user?.avatarUrl ?? null)) patch.avatarUrl = next;
    if (Object.keys(patch).length === 0) return;
    updateMe.mutate(patch);
  };

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwError, setPwError] = useState<string | undefined>();

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (newPw.length < 8) {
      setPwError('新密码至少 8 位');
      return;
    }
    if (newPw !== confirmPw) {
      setPwError('两次输入的新密码不一致');
      return;
    }
    setPwError(undefined);
    changePw.mutate(
      { currentPassword: currentPw, newPassword: newPw },
      {
        onSuccess: () => {
          setCurrentPw('');
          setNewPw('');
          setConfirmPw('');
        },
      },
    );
  };

  return (
    <>
      <Card title="账户信息">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full bg-brand-soft">
              {user?.avatarUrl ? (
                <RemoteImage
                  src={user.avatarUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-brand-ink">
                  <UserIcon size={22} aria-hidden />
                </div>
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{user?.email}</p>
              <p className="text-2xs text-ink-faint">邮箱不可修改</p>
            </div>
          </div>

          <Input
            label="显示名称"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={60}
            placeholder="给自己起个名字"
            disabled={updateMe.isPending}
          />
          <Input
            label="头像链接"
            type="url"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            maxLength={500}
            placeholder="https://…"
            hint="粘贴一张图片的网址；留空则使用默认头像"
            disabled={updateMe.isPending}
          />

          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              disabled={!dirty || updateMe.isPending}
              loading={updateMe.isPending}
            >
              保存修改
            </Button>
          </div>
        </form>
      </Card>

      <Card title="修改密码">
        <form onSubmit={submitPassword} className="flex flex-col gap-4">
          <Input
            label="当前密码"
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            autoComplete="current-password"
            disabled={changePw.isPending}
          />
          <Input
            label="新密码"
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            autoComplete="new-password"
            disabled={changePw.isPending}
          />
          <Input
            label="确认新密码"
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            autoComplete="new-password"
            error={pwError}
            disabled={changePw.isPending}
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              disabled={!currentPw || !newPw || !confirmPw || changePw.isPending}
              loading={changePw.isPending}
            >
              更新密码
            </Button>
          </div>
        </form>
      </Card>

      <Card title="数据概览">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: '书签', value: stats?.bookmarks ?? 0 },
              { label: '标签', value: stats?.tags ?? 0 },
              { label: '收藏', value: stats?.favorites ?? 0 },
              { label: '近 7 天新增', value: stats?.addedLast7Days ?? 0 },
            ].map((item) => (
              <div key={item.label} className="rounded-md bg-sunken px-3 py-2.5">
                <dt className="text-2xs text-ink-faint">{item.label}</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{item.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </>
  );
}

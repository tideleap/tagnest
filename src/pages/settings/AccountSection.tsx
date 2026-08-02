import { Card } from './Card';
import { Skeleton } from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { useStats } from '@/hooks/queries';

export function AccountSection() {
  const user = useAuth((s) => s.user);
  const { data: stats, isLoading } = useStats();

  return (
    <>
      <Card title="账户信息">
        <dl className="flex flex-col gap-2.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">显示名称</dt>
            <dd className="truncate font-medium text-ink">{user?.displayName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">邮箱</dt>
            <dd className="truncate font-medium text-ink">{user?.email}</dd>
          </div>
        </dl>
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

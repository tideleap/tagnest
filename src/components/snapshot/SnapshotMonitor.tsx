import { useEffect, useRef } from 'react';
import { Activity, Camera, RefreshCw } from 'lucide-react';
import type { SnapshotMonitorItem } from '@shared/types';
import { Button, RemoteImage, Skeleton } from '@/components/ui';
import { displayHost, faviconFor, relativeTime } from '@/lib/url';
import { useRefreshSnapshotMonitor, useSnapshotMonitor } from '@/hooks/queries/snapshots';
import { cx } from '@/lib/cx';

interface SnapshotCardProps {
  item: SnapshotMonitorItem;
  onRefresh: (opts: { bookmarkId?: string }) => void;
  isRefreshing: boolean;
}

function SnapshotCard({ item, onRefresh, isRefreshing }: SnapshotCardProps) {
  return (
    <div
      className={cx(
        'group relative flex w-[180px] shrink-0 flex-col overflow-hidden rounded-xl border bg-surface shadow-float transition-all',
        item.isStale ? 'border-caution' : 'border-line hover:border-brand-accent',
      )}
    >
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="relative block aspect-[16/10] overflow-hidden bg-sunken"
        title={`打开 ${displayHost(item.url)}`}
      >
        <RemoteImage
          src={item.snapshotUrl}
          alt={item.title || item.url}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-2xs text-white backdrop-blur-sm">
          <span
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              item.isStale ? 'bg-caution' : 'bg-positive animate-pulse',
            )}
            aria-hidden
          />
          <span>{item.isStale ? '待刷新' : '实时'}</span>
        </div>
      </a>

      <div className="flex min-h-0 flex-1 flex-col justify-between p-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <img
              src={faviconFor(item.url, 32)}
              alt=""
              className="h-3.5 w-3.5 shrink-0"
              loading="lazy"
            />
            <p className="truncate text-xs font-medium text-ink" title={item.title || item.url}>
              {item.title || displayHost(item.url)}
            </p>
          </div>
          <p className="mt-0.5 truncate text-2xs text-ink-faint">
            {item.capturedAt ? relativeTime(item.capturedAt) : '尚未捕获'}
          </p>
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 w-full justify-center text-2xs"
          iconLeft={<RefreshCw size={12} className={cx(isRefreshing && 'animate-spin')} />}
          onClick={() => onRefresh({ bookmarkId: item.bookmarkId })}
          loading={isRefreshing}
          disabled={isRefreshing}
        >
          刷新快照
        </Button>
      </div>
    </div>
  );
}

function SnapshotSkeleton() {
  return (
    <div className="flex w-[180px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-float">
      <Skeleton className="aspect-[16/10] w-full rounded-none" />
      <div className="space-y-2 p-2.5">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-7 w-full" />
      </div>
    </div>
  );
}

interface SnapshotMonitorProps {
  /** Hidden when the user is in search/tag-filter mode. */
  active?: boolean;
}

export function SnapshotMonitor({ active = true }: SnapshotMonitorProps) {
  const monitor = useSnapshotMonitor(active);
  const refresh = useRefreshSnapshotMonitor();
  const autoRefreshedAt = useRef<number>(0);

  // Auto-refresh: every 60s rotate and refresh the stale-est bookmark in the
  // monitor strip. This avoids blocking the page while still keeping snapshots
  // fresh across the whole set.
  useEffect(() => {
    if (!active || !monitor.data?.items.length) return;

    const interval = setInterval(() => {
      if (refresh.isPending) return;
      const now = Date.now();
      if (now - autoRefreshedAt.current < 55_000) return;
      autoRefreshedAt.current = now;
      refresh.mutate({});
    }, 60_000);

    return () => clearInterval(interval);
  }, [active, monitor.data?.items.length, refresh]);

  if (!active) return null;

  const items = monitor.data?.items ?? [];
  const showSkeleton = monitor.isLoading && items.length === 0;
  const empty = !monitor.isLoading && items.length === 0;

  return (
    <section aria-label="网站实时快照" className="mb-4">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-brand-accent" aria-hidden />
          <h2 className="text-sm font-bold text-ink">网站实时快照</h2>
          <span className="inline-flex items-center gap-1 rounded-full bg-positive-soft px-2 py-0.5 text-2xs font-medium text-positive-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-positive animate-pulse" aria-hidden />
            监测中
          </span>
        </div>
        <div className="flex items-center gap-2">
          {monitor.data?.refreshedAt && (
            <span className="hidden text-2xs text-ink-faint sm:inline">
              更新于 {relativeTime(monitor.data.refreshedAt)}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="h-7 text-2xs"
            iconLeft={<Camera size={12} />}
            onClick={() => refresh.mutate({})}
            loading={refresh.isPending || monitor.isFetching}
            disabled={refresh.isPending || monitor.isFetching}
          >
            立即刷新
          </Button>
        </div>
      </div>

      <div className="scrollbar-slim -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {showSkeleton ? (
          <>
            <SnapshotSkeleton />
            <SnapshotSkeleton />
            <SnapshotSkeleton />
          </>
        ) : empty ? (
          <div className="flex h-28 w-full items-center justify-center rounded-xl border border-dashed border-line bg-surface/60 text-2xs text-ink-faint">
            还没有网站快照。打开书签详情并点击「生成快照」后，这里会自动显示实时监测。
          </div>
        ) : (
          items.map((item) => (
            <SnapshotCard
              key={item.bookmarkId}
              item={item}
              onRefresh={(id) => refresh.mutate(id)}
              isRefreshing={refresh.isPending}
            />
          ))
        )}
      </div>
    </section>
  );
}

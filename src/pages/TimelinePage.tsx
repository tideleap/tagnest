import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, ExternalLink } from 'lucide-react';
import type { Bookmark } from '@shared/types';
import { Button, EmptyState, PageHeader, RemoteImage, Skeleton, TagChip } from '@/components/ui';
import { useBookmarks } from '@/hooks/queries';
import { displayHost, faviconFor } from '@/lib/url';

/**
 * O4 — Timeline view.
 *
 * A read-only, chronological walk through the library, grouped by month.
 * It reuses the standard bookmark listing (scope=all, newest first) and
 * buckets the flattened pages by `YYYY-MM`. This is a browsing surface, not
 * an editor — every row links out, and the full editing affordances stay on
 * the library page, so there is exactly one place that mutates data.
 */
export function TimelinePage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useBookmarks({ scope: 'all', sort: 'created_desc', limit: 40 });

  const items = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.items),
    [data],
  );

  // Bucket by calendar month, preserving newest-first order.
  const months = useMemo(() => {
    const map = new Map<string, Bookmark[]>();
    for (const b of items) {
      const d = new Date(b.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const list = map.get(key) ?? [];
      list.push(b);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [items]);

  const monthLabel = (key: string) => {
    const [y, m] = key.split('-');
    return `${y} 年 ${Number(m)} 月`;
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pb-16 pt-2">
      <PageHeader
        icon={<CalendarClock size={20} aria-hidden />}
        eyebrow="浏览"
        title="时间线"
        description="按收藏时间回顾你的书签，最新的在最上面。"
      />

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={<CalendarClock size={22} />}
          title="时间线加载失败"
          description="这不影响你的书签数据，稍后重试即可。"
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<CalendarClock size={22} />}
          title="还没有书签"
          description="添加或导入书签后，它们会按时间出现在这里。"
          action={
            <Button variant="primary" onClick={() => navigate('/import')}>
              去导入
            </Button>
          }
        />
      ) : (
        <ol className="relative flex flex-col gap-8 border-l border-line pl-6">
          {months.map(([key, list]) => (
            <li key={key} className="relative flex flex-col gap-3">
              {/* Month node on the rail */}
              <span
                aria-hidden
                className="absolute -left-[31px] top-1 h-2.5 w-2.5 rounded-full border-2 border-surface bg-brand-accent"
              />
              <h2 className="text-sm font-bold text-ink">
                {monthLabel(key)}
                <span className="ml-2 text-2xs font-normal tabular-nums text-ink-faint">
                  {list.length} 条
                </span>
              </h2>
              <ul className="flex flex-col gap-1.5">
                {list.map((b) => (
                  <li key={b.id}>
                    <a
                      href={b.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-brand/40 hover:bg-surface-hover"
                    >
                      <RemoteImage
                        src={b.faviconUrl ?? faviconFor(b.url)}
                        alt=""
                        className="h-6 w-6 shrink-0 rounded"
                        fallback={
                          <span className="flex h-6 w-6 items-center justify-center rounded bg-brand-soft text-2xs font-bold text-brand-ink">
                            {displayHost(b.url).slice(0, 1).toUpperCase()}
                          </span>
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink group-hover:text-brand-ink">
                          {b.title || displayHost(b.url)}
                        </span>
                        <span className="block truncate text-2xs text-ink-faint">
                          {displayHost(b.url)}
                        </span>
                      </span>
                      {b.tags.slice(0, 2).map((t) => (
                        <TagChip key={t.id} name={t.name} colorIndex={t.colorIndex} size="sm" />
                      ))}
                      <ExternalLink
                        size={14}
                        className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
                        aria-hidden
                      />
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {hasNextPage && !isLoading && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void fetchNextPage()}
            loading={isFetchingNextPage}
          >
            加载更早的书签
          </Button>
        </div>
      )}
    </div>
  );
}

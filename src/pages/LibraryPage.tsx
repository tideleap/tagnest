import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Archive,
  Bookmark as BookmarkIcon,
  Inbox,
  LayoutGrid,
  List,
  Rows3,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import type { BookmarkScope, BookmarkSort } from '@shared/types';
import { Button, EmptyState, SegmentedControl, Select, Skeleton } from '@/components/ui';
import { BookmarkCard } from '@/components/bookmark/BookmarkCard';
import { BulkActionBar } from '@/components/bookmark/BulkActionBar';
import { useOverlay, useSelection, useView } from '@/stores/ui';
import type { ViewMode } from '@/stores/ui';
import {
  useBookmarks,
  useRecordVisit,
  useRestoreBookmarks,
  useTags,
  useToggleFavorite,
  useTrashBookmarks,
  useUpdateBookmark,
  useDeleteForever,
} from '@/hooks/queries';
import { cx } from '@/lib/cx';

const VALID_SCOPES: BookmarkScope[] = ['inbox', 'all', 'favorites', 'archive', 'trash'];

const SCOPE_META: Record<
  BookmarkScope,
  { title: string; icon: typeof Inbox; empty: string; hint: string }
> = {
  inbox: {
    title: '收件箱',
    icon: Inbox,
    empty: '收件箱是空的',
    hint: '还没打标签的书签会先落在这里，整理完就会消失。',
  },
  all: {
    title: '全部书签',
    icon: BookmarkIcon,
    empty: '还没有书签',
    hint: '按 N 添加第一条，或从浏览器导入现有书签。',
  },
  favorites: {
    title: '收藏',
    icon: Star,
    empty: '还没有收藏',
    hint: '点击书签上的星标，它就会出现在这里。',
  },
  archive: {
    title: '归档',
    icon: Archive,
    empty: '归档是空的',
    hint: '暂时用不到又不想删的书签，可以归档留存。',
  },
  trash: {
    title: '回收站',
    icon: Trash2,
    empty: '回收站是空的',
    hint: '删除的书签会在这里保留 30 天。',
  },
};

const SORT_OPTIONS: { value: BookmarkSort; label: string }[] = [
  { value: 'created_desc', label: '最近添加' },
  { value: 'created_asc', label: '最早添加' },
  { value: 'updated_desc', label: '最近更新' },
  { value: 'title_asc', label: '标题 A→Z' },
  { value: 'visits_desc', label: '访问最多' },
];

const VIEW_SEGMENTS = [
  { value: 'list' as ViewMode, label: '列表', icon: <List size={14} /> },
  { value: 'grid' as ViewMode, label: '网格', icon: <LayoutGrid size={14} /> },
  { value: 'compact' as ViewMode, label: '紧凑', icon: <Rows3 size={14} /> },
];

/** Row heights feed the virtualizer's initial estimate; measurement corrects it. */
const ROW_ESTIMATE: Record<ViewMode, number> = { list: 112, grid: 176, compact: 46 };

export function LibraryPage() {
  const navigate = useNavigate();
  const { scope: scopeParam, tagId } = useParams();
  const [params] = useSearchParams();

  const scope: BookmarkScope = VALID_SCOPES.includes(scopeParam as BookmarkScope)
    ? (scopeParam as BookmarkScope)
    : 'all';

  const query = params.get('q') ?? '';
  const { viewMode, sort, setViewMode, setSort } = useView();
  const setEditingBookmarkId = useOverlay((s) => s.setEditingBookmarkId);
  const setQuickAddOpen = useOverlay((s) => s.setQuickAddOpen);
  const { selected, toggle, selectMany, clear } = useSelection();

  const { data: tags } = useTags();
  const activeTag = tagId ? tags?.find((t) => t.id === tagId) : undefined;

  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useBookmarks({
      scope: tagId ? 'all' : scope,
      q: query || undefined,
      tagIds: tagId ? [tagId] : undefined,
      sort,
    });

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = data?.pages[0]?.total ?? 0;

  // Leaving a page with rows still ticked makes the next page act haunted.
  useEffect(() => clear, [scope, tagId, query, clear]);

  const toggleFavorite = useToggleFavorite();
  const updateBookmark = useUpdateBookmark();
  const trashBookmarks = useTrashBookmarks();
  const restoreBookmarks = useRestoreBookmarks();
  const deleteForever = useDeleteForever();
  const recordVisit = useRecordVisit();

  const lastClickedRef = useRef<string | null>(null);

  const handleToggleSelect = useCallback(
    (id: string, shiftKey: boolean) => {
      // Shift-click extends from the previous anchor, matching every file
      // manager people already know.
      if (shiftKey && lastClickedRef.current) {
        const from = items.findIndex((b) => b.id === lastClickedRef.current);
        const to = items.findIndex((b) => b.id === id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const range = items.slice(start, end + 1).map((b) => b.id);
          selectMany([...new Set([...selected, ...range])]);
          return;
        }
      }
      lastClickedRef.current = id;
      toggle(id);
    },
    [items, selected, selectMany, toggle],
  );

  /* -------------------- virtualization -------------------- */

  const scrollRef = useRef<HTMLDivElement>(null);
  const isGrid = viewMode === 'grid';

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE[viewMode],
    overscan: 8,
    gap: isGrid ? 0 : 8,
  });

  // Infinite scroll: pull the next page once the tail is in view.
  const virtualRows = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (!last) return;
    if (last.index >= items.length - 6 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [virtualRows, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const meta = SCOPE_META[scope];
  const HeaderIcon = meta.icon;
  const title = activeTag ? `#${activeTag.name}` : query ? `搜索：${query}` : meta.title;

  const cardHandlers = {
    onToggleSelect: handleToggleSelect,
    onEdit: setEditingBookmarkId,
    onToggleFavorite: (id: string, next: boolean) =>
      toggleFavorite.mutate({ id, isFavorite: next }),
    onArchive: (id: string, next: boolean) =>
      updateBookmark.mutate({ id, patch: { isArchived: next } }),
    onTrash: (id: string) => trashBookmarks.mutate([id]),
    onRestore: (id: string) => restoreBookmarks.mutate([id]),
    onPurge: (id: string) => deleteForever.mutate([id]),
    onVisit: (id: string) => recordVisit.mutate(id),
    onTagClick: (id: string) => navigate(`/tags/${id}`),
  };

  return (
    <div className="flex h-full flex-col">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <HeaderIcon size={19} className="shrink-0 text-ink-faint" aria-hidden />
          <h1 className="min-w-0 truncate text-lg font-semibold text-ink">{title}</h1>
          {!isLoading && (
            <span className="shrink-0 text-xs tabular-nums text-ink-faint">{total}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Select
            aria-label="排序方式"
            size="sm"
            value={sort}
            onChange={(e) => setSort(e.target.value as BookmarkSort)}
            options={SORT_OPTIONS}
            containerClassName="w-32"
          />
          <SegmentedControl
            label="视图密度"
            size="sm"
            value={viewMode}
            onChange={setViewMode}
            segments={VIEW_SEGMENTS}
          />
        </div>
      </header>

      {isError && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-critical bg-critical-soft px-3.5 py-2.5 text-sm text-critical-ink"
        >
          加载失败：{(error as Error).message}
        </div>
      )}

      {isLoading ? (
        <ul className="flex flex-col gap-2" aria-busy>
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="rounded-md border border-line bg-surface p-3.5">
              <div className="flex gap-3">
                <Skeleton className="h-5 w-5 shrink-0 rounded-sm" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        query ? (
          <EmptyState
            icon={<Search size={22} />}
            title="没有找到匹配的书签"
            description={`没有标题、链接、笔记或标签匹配「${query}」。换个关键词试试。`}
          />
        ) : (
          <EmptyState
            icon={<HeaderIcon size={22} />}
            title={activeTag ? `标签 #${activeTag.name} 下还没有书签` : meta.empty}
            description={activeTag ? '给书签加上这个标签后会出现在这里。' : meta.hint}
            action={
              scope === 'all' || scope === 'inbox' ? (
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => setQuickAddOpen(true)}>
                    添加书签
                  </Button>
                  <Button variant="ghost" onClick={() => navigate('/import')}>
                    从浏览器导入
                  </Button>
                </div>
              ) : undefined
            }
          />
        )
      ) : (
        <div
          ref={scrollRef}
          className="scrollbar-slim min-h-0 flex-1 overflow-y-auto"
          style={{ maxHeight: 'calc(100dvh - 11rem)' }}
        >
          {isGrid ? (
            // Grid density defers to CSS columns — virtualizing a responsive
            // grid buys little and breaks keyboard order.
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((b) => (
                <li key={b.id}>
                  <BookmarkCard
                    bookmark={b}
                    view={viewMode}
                    selected={selected.has(b.id)}
                    selectionActive={selected.size > 0}
                    {...cardHandlers}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div
              className="relative w-full"
              style={{ height: rowVirtualizer.getTotalSize() }}
              role="list"
            >
              {virtualRows.map((row) => {
                const b = items[row.index];
                if (!b) return null;
                return (
                  <div
                    key={b.id}
                    role="listitem"
                    ref={rowVirtualizer.measureElement}
                    data-index={row.index}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    <BookmarkCard
                      bookmark={b}
                      view={viewMode}
                      selected={selected.has(b.id)}
                      selectionActive={selected.size > 0}
                      {...cardHandlers}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {isFetchingNextPage && (
            <p className="py-4 text-center text-xs text-ink-faint">正在加载更多…</p>
          )}
          {!hasNextPage && items.length > 20 && (
            <p className={cx('py-4 text-center text-xs text-ink-faint')}>已经到底了</p>
          )}
        </div>
      )}

      <BulkActionBar scope={scope} allIds={items.map((b) => b.id)} />
    </div>
  );
}

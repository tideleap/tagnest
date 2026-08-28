import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Archive,
  Bookmark as BookmarkIcon,
  BookmarkPlus,
  FolderTree,
  Inbox,
  LayoutGrid,
  List,
  Rows3,
  Search,
  Star,
  X,
  Trash2,
} from 'lucide-react';
import type { Bookmark, BookmarkScope, BookmarkSort, Collection, SavedSearchQuery, Tag } from '@shared/types';
import {
  Badge,
  Button,
  ConfirmDialog,
  DialogFooter,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  TagChip,
} from '@/components/ui';
import { BookmarkCard } from '@/components/bookmark/BookmarkCard';
import { BulkActionBar } from '@/components/bookmark/BulkActionBar';
import { CategoryView } from '@/components/library/CategoryView';
import { useOverlay, useSelection, useView } from '@/stores/ui';
import type { ViewMode } from '@/stores/ui';
import {
  useBookmarks,
  useRecordVisit,
  useReorderBookmarks,
  useRestoreBookmarks,
  useTags,
  useToggleFavorite,
  useTrashBookmarks,
  useUpdateBookmark,
  useDeleteForever,
  useCreateCollection,
} from '@/hooks/queries';
import { useSetBookmarkPrivate } from '@/hooks/queries/vault';
import { useVault } from '@/stores/vault';
import { toast } from '@/components/ui/Toast';
import { cx } from '@/lib/cx';

const VALID_SCOPES: BookmarkScope[] = ['inbox', 'all', 'favorites', 'archive', 'trash'];

/** Editorial section index per scope, matching the sidebar order (16 sections). */
const SCOPE_INDEX: Record<BookmarkScope, string> = {
  inbox: '02 / 16',
  all: '03 / 16',
  favorites: '04 / 16',
  archive: '05 / 16',
  trash: '15 / 16',
};

const SCOPE_META: Record<
  BookmarkScope,
  { title: string; icon: typeof Inbox; empty: string; hint: string }
> = {
  inbox: {
    title: '收件箱',
    icon: Inbox,
    empty: '收件箱是空的',
    hint: '从浏览器扩展收藏的页面会先落在这里；打上标签（或接受 AI 建议）即完成归档。',
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
  { value: 'manual', label: '手动排序' },
];

const VIEW_SEGMENTS = [
  { value: 'list' as ViewMode, label: '列表', icon: <List size={14} /> },
  { value: 'grid' as ViewMode, label: '网格', icon: <LayoutGrid size={14} /> },
  { value: 'compact' as ViewMode, label: '紧凑', icon: <Rows3 size={14} /> },
  { value: 'category' as ViewMode, label: '分类', icon: <FolderTree size={14} /> },
];

/** Row heights feed the virtualizer's initial estimate; measurement corrects it. */
const ROW_ESTIMATE: Record<ViewMode, number> = { list: 112, grid: 176, compact: 46, category: 176 };

export function LibraryPage() {
  const navigate = useNavigate();
  const { scope: scopeParam } = useParams();
  const [params, setParams] = useSearchParams();

  const scope: BookmarkScope = VALID_SCOPES.includes(scopeParam as BookmarkScope)
    ? (scopeParam as BookmarkScope)
    : 'all';

  const query = params.get('q') ?? '';

  // Multi-tag filter lives in the URL search param `?tagIds=a,b,c` so it can be
  // cleared in place and is shareable. Parsed into a stable array for the query
  // key (avoids infinite re-fetch from a fresh array literal each render).
  const tagIds = useMemo(
    () =>
      (params.get('tagIds') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [params],
  );

  const { viewMode, sort, setViewMode, setSort } = useView();
  const setEditingBookmarkId = useOverlay((s) => s.setEditingBookmarkId);
  const setQuickAddOpen = useOverlay((s) => s.setQuickAddOpen);
  const { selected, toggle, selectMany, clear } = useSelection();

  const { data: tags } = useTags();
  const [saving, setSaving] = useState(false);

  // Resolve the selected tag ids into live Tag objects (fall back to id-only
  // stubs if tags haven't loaded) for the header chips.
  const activeTags: Tag[] = useMemo(() => {
    const map = new Map((tags ?? []).map((t) => [t.id, t]));
    return tagIds
      .map((id) => map.get(id))
      .filter((t): t is Tag => Boolean(t));
  }, [tags, tagIds]);

  /** Rewrites `?tagIds=` to the given ids, preserving q and everything else. */
  const setTagFilter = useCallback(
    (nextIds: string[]) => {
      const next = new URLSearchParams(params);
      if (nextIds.length > 0) next.set('tagIds', nextIds.join(','));
      else next.delete('tagIds');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  /** Toggle a tag in/out of the multi-filter (accumulative click behavior). */
  const toggleTag = useCallback(
    (id: string) => {
      const has = tagIds.includes(id);
      setTagFilter(has ? tagIds.filter((t) => t !== id) : [...tagIds, id]);
    },
    [tagIds, setTagFilter],
  );

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useBookmarks({
    scope: tagIds.length > 0 ? 'all' : scope,
    q: query || undefined,
    tagIds: tagIds.length > 0 ? tagIds : undefined,
    sort,
  });

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = data?.pages[0]?.total ?? 0;

  // Leaving a page with rows still ticked makes the next page act haunted.
  useEffect(() => clear, [scope, tagIds, query, clear]);

  const toggleFavorite = useToggleFavorite();
  const updateBookmark = useUpdateBookmark();
  const trashBookmarks = useTrashBookmarks();
  const restoreBookmarks = useRestoreBookmarks();
  const deleteForever = useDeleteForever();
  const recordVisit = useRecordVisit();
  const reorder = useReorderBookmarks();
  const setBookmarkPrivate = useSetBookmarkPrivate();

  // Drag-to-reorder only makes sense when the backend is honouring the manual
  // order, i.e. this sort is active and we are not reshuffling the trash.
  const isManualSort = sort === 'manual';
  const dragEnabled = isManualSort && scope !== 'trash';

  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  /** Bookmark awaiting an irreversible purge confirmation. */
  const [purgeId, setPurgeId] = useState<string | null>(null);
  /** Bookmark awaiting confirmation before being encrypted into the vault. */
  const [privateTarget, setPrivateTarget] = useState<Bookmark | null>(null);

  // Any change of context invalidates an in-flight drag.
  useEffect(() => {
    setDragId(null);
    setOverId(null);
  }, [sort, scope, tagIds, query]);

  const handleReorder = useCallback(
    (targetId: string) => {
      if (!dragId || dragId === targetId) {
        setDragId(null);
        setOverId(null);
        return;
      }
      const from = items.findIndex((i) => i.id === dragId);
      const to = items.findIndex((i) => i.id === targetId);
      if (from < 0 || to < 0) {
        setDragId(null);
        setOverId(null);
        return;
      }
      // Rebuild the visible id order with the dragged card relocated to the
      // drop target's slot; the API re-weights exactly these ids.
      const next = items.map((i) => i.id);
      next.splice(from, 1);
      next.splice(to, 0, dragId);
      reorder.mutate(next);
      setDragId(null);
      setOverId(null);
    },
    [dragId, items, reorder],
  );

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

  // The category view groups the WHOLE library, so eagerly pull every page
  // instead of waiting on the (unused-in-this-mode) virtualizer to request the
  // tail. Re-fires until the cursor is exhausted.
  useEffect(() => {
    if (viewMode === 'category' && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [viewMode, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const meta = SCOPE_META[scope];
  const HeaderIcon = meta.icon;
  const title = activeTags.length > 0
    ? `${activeTags.length} 个标签`
    : query
      ? `搜索：${query}`
      : meta.title;

  const cardHandlers = {
    onToggleSelect: handleToggleSelect,
    onEdit: setEditingBookmarkId,
    onToggleFavorite: (id: string, next: boolean) =>
      toggleFavorite.mutate({ id, isFavorite: next }),
    onArchive: (id: string, next: boolean) =>
      updateBookmark.mutate({ id, patch: { isArchived: next } }),
    onTrash: (id: string) => trashBookmarks.mutate([id]),
    onRestore: (id: string) => restoreBookmarks.mutate([id]),
    // Purging is irreversible, so it goes through the same confirmation gate the
    // bulk bar already uses — a single misclick must not destroy data.
    onPurge: (id: string) => setPurgeId(id),
    onVisit: (id: string) => recordVisit.mutate(id),
    onTagClick: toggleTag,
    // Encryption needs the vault key, which only exists in memory after an
    // unlock. Without it there is nothing to encrypt with, so send the user to
    // the vault instead of failing silently at mutation time.
    onSetPrivate: (b: Bookmark) => {
      if (!useVault.getState().getKey()) {
        toast.info('请先解锁私密保险库', '解锁后即可把书签加密移入私密空间。');
        navigate('/private');
        return;
      }
      setPrivateTarget(b);
    },
  };

  const purgeTarget = purgeId ? items.find((b) => b.id === purgeId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<HeaderIcon size={16} aria-hidden />}
        eyebrow="书签分区"
        index={SCOPE_INDEX[scope]}
        title={title}
      >
        {!isLoading && (
          <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-xs tabular-nums text-ink-faint">
            {total}
          </span>
        )}
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
        {!isLoading && (
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<BookmarkPlus size={15} />}
            disabled={query.trim().length === 0 && tagIds.length === 0}
            onClick={() => setSaving(true)}
            title={
              query.trim().length === 0 && tagIds.length === 0
                ? '先设置搜索条件（关键词或标签）'
                : '把当前搜索保存为智能集合'
            }
          >
            保存为智能集合
          </Button>
        )}
        {dragEnabled && viewMode !== 'category' && (
          <span className="hidden text-2xs text-ink-faint lg:inline">拖动书签左侧手柄可调整顺序</span>
        )}
      </PageHeader>

      {activeTags.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {activeTags.map((t) => (
            <TagChip
              key={t.id}
              name={t.name}
              colorIndex={t.colorIndex}
              size="sm"
              active
              onClick={() => toggleTag(t.id)}
              onRemove={() => toggleTag(t.id)}
            />
          ))}
          {activeTags.length > 1 && (
            <button
              type="button"
              onClick={() => setTagFilter([])}
              className="inline-flex h-5.5 items-center gap-1 rounded-full border border-line px-2 text-2xs font-medium text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
            >
              <X size={11} aria-hidden />
              清除全部
            </button>
          )}
        </div>
      )}

      {/* Lead with a plain-language line and a way out; the raw exception text
          is kept, but demoted to an expandable detail for bug reports. */}
      {isError && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-critical bg-critical-soft px-3.5 py-2.5 text-sm text-critical-ink"
        >
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1">
              没能加载书签列表。可能是网络不稳定，请稍后重试。
            </p>
            <Button size="sm" variant="secondary" onClick={() => void refetch()} loading={isFetching}>
              重试
            </Button>
          </div>
          {error instanceof Error && error.message && (
            <details className="mt-2">
              <summary className="cursor-pointer text-2xs opacity-80">技术详情</summary>
              <p className="mt-1 break-words text-2xs opacity-80">{error.message}</p>
            </details>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5" aria-busy>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3.5 rounded-lg border border-line bg-surface p-3.5">
              <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
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
            title={activeTags.length > 0 ? `这些标签下还没有书签` : meta.empty}
            description={
              activeTags.length > 0
                ? `同时匹配 ${activeTags.map((t) => `#${t.name}`).join('、')} 的书签会出现在这里。`
                : meta.hint
            }
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
          {viewMode === 'category' ? (
            <CategoryView bookmarks={items} tags={tags ?? []} />
          ) : isGrid ? (
            // Grid density defers to CSS columns — virtualizing a responsive
            // grid buys little and breaks keyboard order. Off-screen cards
            // skip layout/paint via content-visibility instead (DOM order,
            // and thus tab order, is untouched).
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {items.map((b) => (
                <li
                  key={b.id}
                  className="cv-auto"
                  onDragOver={
                    dragEnabled
                      ? (e) => {
                          e.preventDefault();
                          if (overId !== b.id) setOverId(b.id);
                        }
                      : undefined
                  }
                  onDrop={
                    dragEnabled
                      ? (e) => {
                          e.preventDefault();
                          handleReorder(b.id);
                        }
                      : undefined
                  }
                >
                  <BookmarkCard
                    bookmark={b}
                    view={viewMode}
                    selected={selected.has(b.id)}
                    selectionActive={selected.size > 0}
                    draggable={dragEnabled}
                    onDragStartCard={setDragId}
                    isDragOver={dragEnabled && overId === b.id}
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
                    onDragOver={
                      dragEnabled
                        ? (e) => {
                            e.preventDefault();
                            if (overId !== b.id) setOverId(b.id);
                          }
                        : undefined
                    }
                    onDrop={
                      dragEnabled
                        ? (e) => {
                            e.preventDefault();
                            handleReorder(b.id);
                          }
                        : undefined
                    }
                  >
                    <BookmarkCard
                      bookmark={b}
                      view={viewMode}
                      selected={selected.has(b.id)}
                      selectionActive={selected.size > 0}
                      draggable={dragEnabled}
                      onDragStartCard={setDragId}
                      isDragOver={dragEnabled && overId === b.id}
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

      <ConfirmDialog
        open={purgeId !== null}
        onClose={() => setPurgeId(null)}
        onConfirm={() => {
          if (purgeId) deleteForever.mutate([purgeId]);
          setPurgeId(null);
        }}
        title="永久删除这条书签？"
        message={
          purgeTarget
            ? `「${purgeTarget.title || purgeTarget.url}」将被彻底移除，无法再恢复。`
            : '这条书签将被彻底移除，无法再恢复。'
        }
        confirmLabel="永久删除"
        tone="danger"
        loading={deleteForever.isPending}
      />

      <ConfirmDialog
        open={privateTarget !== null}
        onClose={() => setPrivateTarget(null)}
        onConfirm={() => {
          if (privateTarget) setBookmarkPrivate.mutate(privateTarget);
          setPrivateTarget(null);
        }}
        title="移入私密保险库？"
        message={
          privateTarget
            ? `「${privateTarget.title || privateTarget.url}」将在本地加密后保存，并从全部列表、搜索、标签与分享中彻底隐藏，只能在解锁保险库后查看。`
            : ''
        }
        confirmLabel="加密并隐藏"
        loading={setBookmarkPrivate.isPending}
      />

      <SaveSmartCollectionDialog
        open={saving}
        q={query}
        tagIds={tagIds}
        scope={tagIds.length > 0 ? 'all' : scope}
        sort={sort}
        onClose={() => setSaving(false)}
      />
    </div>
  );
}

/**
 * Saves the current Library search as a smart (query-driven) collection. The
 * query is serialized exactly as the backend expects; members are resolved
 * live, so the collection stays consistent with the library.
 */
function SaveSmartCollectionDialog({
  open,
  q,
  tagIds,
  scope,
  sort,
  onClose,
}: {
  open: boolean;
  q: string;
  tagIds: string[];
  scope: BookmarkScope;
  sort: BookmarkSort;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data: allTags } = useTags();
  const create = useCreateCollection();

  const query: SavedSearchQuery = {
    q: q.trim() || null,
    tagIds,
    matchAllTags: false,
    scope,
    sort,
  };

  const defaultName = q.trim()
    ? `搜索：${q.trim()}`
    : tagIds.length > 0
      ? `${tagIds.length} 个标签`
      : '智能集合';

  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string>();

  const lastKey = `${open}`;
  const [seenOpen, setSeenOpen] = useState(lastKey);
  if (seenOpen !== lastKey) {
    setSeenOpen(lastKey);
    setName(defaultName);
    setError(undefined);
  }

  const summary = (() => {
    const parts: string[] = [];
    if (query.q) parts.push(`“${query.q}”`);
    if (query.tagIds.length > 0) {
      const names = query.tagIds.map((id) => allTags?.find((t) => t.id === id)?.name ?? id);
      parts.push(names.join(' · '));
    }
    const SCOPE_LABEL: Record<string, string> = {
      inbox: '收件箱',
      all: '全部',
      favorites: '收藏',
      archive: '归档',
      trash: '回收站',
    };
    const SORT_LABEL: Record<string, string> = {
      created_desc: '最新',
      created_asc: '最早',
      updated_desc: '最近更新',
      title_asc: '标题',
      visits_desc: '最多访问',
      manual: '手动',
    };
    parts.push(SCOPE_LABEL[query.scope] ?? query.scope);
    parts.push(SORT_LABEL[query.sort] ?? query.sort);
    return parts.join(' · ');
  })();

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('集合名称不能为空');
      return;
    }
    create.mutate(
      { name: trimmed, kind: 'smart', query },
      {
        onSuccess: (col: Collection) => {
          onClose();
          navigate(`/collections/${col.id}`);
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="保存为智能集合"
      size="sm"
      footer={
        <DialogFooter
          onCancel={onClose}
          onSubmit={submit}
          loading={create.isPending}
          submitLabel="保存"
        />
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
          <Badge tone="brand">实时</Badge>
          <span className="text-xs text-ink-soft">{summary}</span>
        </div>
        <Input
          autoFocus
          label="集合名称"
          value={name}
          error={error}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="例如：设计参考"
        />
        <p className="text-2xs text-ink-faint">
          智能集合的成员由该搜索条件实时计算，新增或调整书签后会自动更新，无需手动维护。
        </p>
      </div>
    </Modal>
  );
}

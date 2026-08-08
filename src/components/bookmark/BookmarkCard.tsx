import { memo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Camera,
  Copy,
  ExternalLink,
  FolderPlus,
  GripVertical,
  Heart,
  Images,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Star,
  Trash2,
} from 'lucide-react';
import type { Bookmark } from '@shared/types';
import { cx } from '@/lib/cx';
import { displayHost, faviconFor, relativeTime } from '@/lib/url';
import { Button, IconButton, Menu, Modal, TagChip, RemoteImage, tagColorVars } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { useBookmarkSnapshots, useGenerateSnapshot } from '@/hooks/queries/snapshots';
import { useAddToCollection, useCollections } from '@/hooks/queries';
import type { ViewMode } from '@/stores/ui';

export interface BookmarkCardProps {
  bookmark: Bookmark;
  view: ViewMode;
  selected: boolean;
  selectionActive: boolean;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onEdit: (id: string) => void;
  onToggleFavorite: (id: string, next: boolean) => void;
  onArchive: (id: string, next: boolean) => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  onVisit: (id: string) => void;
  onTagClick: (tagId: string) => void;
  /** When true, a grip handle appears and the card is part of a manual order. */
  draggable?: boolean;
  onDragStartCard?: (id: string) => void;
  isDragOver?: boolean;
}

/**
 * Deterministic ZIYK-style colour for a circle badge.
 * Picks from a saturated palette based on the host/title so the same
 * bookmark always renders the same colour, and neighbours feel varied.
 */
const CIRCLE_PALETTE = [
  '#8b5cf6', // violet
  '#3b82f6', // blue
  '#06b6d4', // cyan
  '#14b8a6', // teal
  '#22c55e', // green
  '#f59e0b', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#ec4899', // pink
  '#d946ef', // fuchsia
  '#6366f1', // indigo
];

function circleColorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % CIRCLE_PALETTE.length;
  return CIRCLE_PALETTE[idx];
}

/**
 * FaviconBadge — the shared visual anchor across all three densities.
 *
 * A warm brand-tinted rounded tile with the favicon centred. Anchor point keeps
 * each row aligned and gives the eye a consistent place to land regardless of
 * view; the fallback letter (host initial) keeps even a missing-favicon card
 * from looking empty.
 */
function FaviconBadge({
  bookmark,
  size,
  className,
}: {
  bookmark: Bookmark;
  size: number;
  className?: string;
}) {
  const src = bookmark.faviconUrl ?? faviconFor(bookmark.url);
  const radiusCls = size >= 32 ? 'rounded-lg' : 'rounded-md';
  return (
    <span
      className={cx('favicon-badge shrink-0 overflow-hidden', radiusCls, className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <RemoteImage
        src={src}
        alt=""
        width={size * 0.62}
        height={size * 0.62}
        className="object-contain"
        fallback={
          <span
            className="flex h-full w-full items-center justify-center text-2xs font-bold uppercase text-brand-ink"
            aria-hidden
          >
            {displayHost(bookmark.url).charAt(0)}
          </span>
        }
      />
    </span>
  );
}

/**
 * CircleBadge — ZIYK-style large coloured circle with a white initial.
 * Used in grid view as the dominant visual anchor.
 */
function CircleBadge({
  bookmark,
  size = 48,
  className,
}: {
  bookmark: Bookmark;
  size?: number;
  className?: string;
}) {
  const seed = bookmark.title || displayHost(bookmark.url);
  const initial = seed.trim().charAt(0) || '?';
  const bg = circleColorFor(seed);
  return (
    <span
      className={cx(
        'flex shrink-0 items-center justify-center rounded-full font-bold text-white shadow-sm',
        className,
      )}
      style={{ width: size, height: size, backgroundColor: bg, fontSize: size * 0.42 }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

/** Compact single-line host — right-aligned, muted, truncated. */
function CompactHost({ bookmark }: { bookmark: Bookmark }) {
  return (
    <span className="hidden shrink-0 items-center gap-1.5 text-2xs text-ink-faint min-[420px]:flex">
      <FaviconBadge bookmark={bookmark} size={16} className="rounded" />
      <span className="max-w-32 truncate">{displayHost(bookmark.url)}</span>
    </span>
  );
}

function BookmarkCardBase({
  bookmark: b,
  view,
  selected,
  selectionActive,
  onToggleSelect,
  onEdit,
  onToggleFavorite,
  onArchive,
  onTrash,
  onRestore,
  onPurge,
  onVisit,
  onTagClick,
  draggable = false,
  onDragStartCard,
  isDragOver = false,
}: BookmarkCardProps) {
  const inTrash = b.deletedAt !== null;

  // "加入集合" — collections the user can add this bookmark to. TanStack Query
  // dedupes the shared key across every card, so this is a single fetch.
  const { data: collections } = useCollections();
  const addToCollection = useAddToCollection();
  const [showAddToCollection, setShowAddToCollection] = useState(false);

  // F3 — the snapshot backend has been orphaned on the frontend until now.
  // `generate` fires POST /bookmarks/:id/snapshot; the history query backs the
  // viewer modal and only runs once it is actually opened.
  const generate = useGenerateSnapshot();
  const [showSnapshots, setShowSnapshots] = useState(false);
  const {
    data: snapList,
    isLoading: snapsLoading,
    isError: snapsError,
    refetch: refetchSnaps,
  } = useBookmarkSnapshots(b.id, showSnapshots);

  const open = () => {
    onVisit(b.id);
    window.open(b.url, '_blank', 'noopener,noreferrer');
  };

  const grip = draggable ? (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', b.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStartCard?.(b.id);
      }}
      aria-label="拖动以重新排序"
      className="flex h-6 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-sunken hover:text-ink-soft active:cursor-grabbing"
    >
      <GripVertical size={15} aria-hidden />
    </button>
  ) : null;

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(b.url);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败', '浏览器拒绝了剪贴板访问');
    }
  };

  const menuItems = inTrash
    ? [
        {
          id: 'restore',
          label: '恢复',
          icon: <RotateCcw size={15} />,
          onSelect: () => onRestore(b.id),
        },
        {
          id: 'purge',
          label: '永久删除',
          icon: <Trash2 size={15} />,
          tone: 'danger' as const,
          separatorBefore: true,
          onSelect: () => onPurge(b.id),
        },
      ]
    : [
        { id: 'open', label: '打开链接', icon: <ExternalLink size={15} />, onSelect: open },
        { id: 'edit', label: '编辑', icon: <Pencil size={15} />, onSelect: () => onEdit(b.id) },
        { id: 'copy', label: '复制链接', icon: <Copy size={15} />, onSelect: () => void copyUrl() },
        {
          id: 'add-to-collection',
          label: '加入集合',
          icon: <FolderPlus size={15} />,
          separatorBefore: true,
          onSelect: () => setShowAddToCollection(true),
        },
        {
          id: 'snapshot',
          label: '生成网页快照',
          icon: <Camera size={15} />,
          separatorBefore: true,
          disabled: generate.isPending,
          onSelect: () => generate.mutate(b.id),
        },
        ...(b.snapshotKey
          ? [
              {
                id: 'view-snapshots',
                label: '查看快照历史',
                icon: <Images size={15} />,
                onSelect: () => setShowSnapshots(true),
              },
            ]
          : []),
        {
          id: 'archive',
          label: b.isArchived ? '取消归档' : '归档',
          icon: b.isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />,
          separatorBefore: true,
          onSelect: () => onArchive(b.id, !b.isArchived),
        },
        {
          id: 'trash',
          label: '移入回收站',
          icon: <Trash2 size={15} />,
          tone: 'danger' as const,
          onSelect: () => onTrash(b.id),
        },
      ];

  const isCompact = view === 'compact';
  const isGrid = view === 'grid';

  /** Checkbox — appears over the top-left on hover, permanent once selecting. */
  const checkbox = (
    <label
      className={cx(
        'absolute left-2 top-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-opacity',
        selectionActive || selected
          ? 'opacity-100'
          : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
      )}
    >
      <span className="sr-only">选择《{b.title}》</span>
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) => onToggleSelect(b.id, (e.nativeEvent as MouseEvent).shiftKey)}
        className="h-3.5 w-3.5 cursor-pointer rounded border border-line-strong accent-[var(--color-brand)]"
      />
    </label>
  );

  const star = !inTrash ? (
    <IconButton
      label={b.isFavorite ? '取消收藏' : '收藏'}
      size="sm"
      pressed={b.isFavorite}
      icon={<Star size={15} className={b.isFavorite ? 'fill-caution text-caution' : ''} aria-hidden />}
      onClick={() => onToggleFavorite(b.id, !b.isFavorite)}
      className={cx(
        'transition-all duration-150',
        !b.isFavorite && 'opacity-0 focus:opacity-100 group-hover:opacity-100',
        b.isFavorite && 'scale-100',
      )}
    />
  ) : null;

  const more = (
    <Menu
      align="end"
      width={180}
      trigger={(props) => (
        <IconButton
          {...props}
          label="更多操作"
          size="sm"
          icon={<MoreHorizontal size={16} />}
          className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
        />
      )}
      items={menuItems}
    />
  );

  return (
    <>
      <article
      className={cx(
        'card-halo group relative flex bg-surface',
        'card-lift border border-line hover:border-line-strong',
        isGrid
          ? 'h-full flex-col rounded-lg p-3'
          : 'items-center rounded-lg',
        isCompact ? 'gap-2.5 py-1.5 pl-2.5 pr-2' : 'gap-3.5 py-3.5 pl-3.5 pr-3',
        selected && 'border-brand bg-brand-soft/30',
        isDragOver && 'border-brand ring-2 ring-brand/50',
      )}
    >
      {checkbox}

      {/* ---- Compact: one tight row, host on the right ---- */}
      {isCompact ? (
        <>
          {grip}
          <FaviconBadge bookmark={b} size={22} />
          <h3 className="min-w-0 flex-1 truncate text-sm text-ink">
            <button type="button" onClick={open} className="truncate underline-offset-2 hover:text-brand-ink hover:underline">
              {b.title || displayHost(b.url)}
            </button>
          </h3>
          {b.tags.length > 0 && (
            <span className="hidden shrink-0 text-2xs text-ink-faint sm:inline">
              {b.tags.length} 标签
            </span>
          )}
          <CompactHost bookmark={b} />
          <div className="flex shrink-0 items-center gap-0.5">
            {star}
            {more}
          </div>
        </>
      ) : (
        <>
          {isGrid ? (
            /* ---- Grid: ZIYK-style card optimized for a dense 6-column grid.
                    A large centred circle badge acts as the hero visual; title,
                    compact #hashtag pills and the red stat pill are stacked below.
                    No duplicate badge, no tall cover — cards stay readable at
                    ~170 px wide. ---- */
            <>              {/* Top hero strip — first-party R2 website snapshot when one
                  exists, else the raw remote cover, else a circle badge. */}
              {b.snapshotKey ? (
                <div className="relative -mx-3 -mt-3 mb-3 aspect-[16/10] overflow-hidden rounded-t-lg bg-sunken">
                  <RemoteImage
                    src={`/api/snapshots/${b.snapshotKey}`}
                    alt=""
                    className="h-full w-full object-cover"
                    fallback={
                      <div className="flex h-full w-full items-center justify-center bg-brand-soft/30">
                        <CircleBadge bookmark={b} size={56} />
                      </div>
                    }
                  />
                </div>
              ) : b.coverUrl ? (
                <div className="relative -mx-3 -mt-3 mb-3 aspect-[16/10] overflow-hidden rounded-t-lg bg-sunken">
                  <RemoteImage
                    src={b.coverUrl}
                    alt=""
                    className="h-full w-full object-cover"
                    fallback={
                      <div className="flex h-full w-full items-center justify-center bg-brand-soft/30">
                        <CircleBadge bookmark={b} size={56} />
                      </div>
                    }
                  />
                </div>
              ) : (
                <div className="relative -mx-3 -mt-3 mb-3 flex aspect-[16/10] items-center justify-center overflow-hidden rounded-t-lg bg-brand-soft/30">
                  <CircleBadge bookmark={b} size={56} />
                </div>
              )}

              <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                <h3 className="font-bold leading-snug text-ink">
                  <button
                    type="button"
                    onClick={open}
                    className="text-left text-sm underline-offset-2 transition-colors hover:text-brand-ink hover:underline line-clamp-2"
                  >
                    {b.title || displayHost(b.url)}
                  </button>
                </h3>

                {b.tags.length > 0 && (
                  <ul className="flex flex-wrap gap-1">
                    {b.tags.slice(0, 2).map((tag) => (
                      <li key={tag.id}>
                        <button
                          type="button"
                          onClick={() => onTagClick(tag.id)}
                          className="inline-flex items-center rounded bg-sunken px-1.5 py-0.5 text-2xs font-medium text-ink-soft transition-colors hover:bg-brand-soft hover:text-brand-ink"
                        >
                          #{tag.name}
                        </button>
                      </li>
                    ))}
                    {b.tags.length > 2 && (
                      <li className="self-center text-2xs text-ink-faint">+{b.tags.length - 2}</li>
                    )}
                  </ul>
                )}

                {/* Bottom row — left label + right red stat pill / actions */}
                <div className="mt-auto flex items-center justify-between gap-1 border-t border-line pt-2">
                  <span className="shrink-0 text-2xs font-medium text-ink-faint">TagNest</span>

                  <div className="flex shrink-0 items-center gap-1">
                    {b.visitCount > 0 && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-critical px-1.5 py-0.5 text-2xs font-semibold text-white shadow-sm">
                        <Heart size={10} className="fill-white" aria-hidden />
                        <span className="tabular-nums">{b.visitCount}</span>
                      </span>
                    )}
                    <div className="flex items-center gap-0.5">
                      {grip}
                      {star}
                      {more}
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* ---- List: left favicon rail + stacked content ---- */
            <>
              <div className="flex shrink-0 flex-col items-center gap-1.5">
                {grip}
                <FaviconBadge bookmark={b} size={40} />
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <h3 className="font-semibold leading-snug text-ink">
                  <button
                    type="button"
                    onClick={open}
                    className="text-left text-sm underline-offset-2 transition-colors hover:text-brand-ink hover:underline line-clamp-2"
                  >
                    {b.title || displayHost(b.url)}
                  </button>
                </h3>

                {(b.description || b.note) && (
                  <p className="line-clamp-2 text-xs leading-relaxed text-ink-soft">
                    {b.note || b.description}
                  </p>
                )}

                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-faint">
                  <span className="truncate">{displayHost(b.url)}</span>
                  <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-line-strong" aria-hidden />
                  <time dateTime={b.createdAt} className="shrink-0">
                    {relativeTime(b.createdAt)}
                  </time>
                  {b.visitCount > 0 && (
                    <>
                      <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-line-strong" aria-hidden />
                      <span className="shrink-0 tabular-nums">{b.visitCount} 次访问</span>
                    </>
                  )}
                </div>

                {b.tags.length > 0 && (
                  <ul className="mt-1.5 flex flex-wrap gap-1">
                    {b.tags.slice(0, 4).map((tag) => (
                      <li key={tag.id}>
                        <TagChip
                          name={tag.name}
                          colorIndex={tag.colorIndex}
                          size="sm"
                          onClick={() => onTagClick(tag.id)}
                        />
                      </li>
                    ))}
                    {b.tags.length > 4 && (
                      <li className="self-center text-2xs text-ink-faint">+{b.tags.length - 4}</li>
                    )}
                  </ul>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-0.5 self-start">
                {star}
                {more}
              </div>
            </>
          )}
        </>
      )}

      {inTrash && b.deletedAt && (
        <span className="absolute bottom-1.5 right-2 text-2xs text-ink-faint">
          {relativeTime(b.deletedAt)}删除
        </span>
      )}
    </article>

    <Modal
      open={showSnapshots}
      onClose={() => setShowSnapshots(false)}
      title="网页快照历史"
      size="lg"
    >
      {snapsLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-ink-faint">加载中…</div>
      ) : snapsError ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-ink-faint">
          <span>快照历史加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => void refetchSnaps()}>
            重试
          </Button>
        </div>
      ) : snapList && snapList.snapshots.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {snapList.snapshots.map((s) => (
            <li key={s.key} className="overflow-hidden rounded-lg border border-line">
              <a href={s.url} target="_blank" rel="noreferrer noopener">
                <RemoteImage
                  src={s.url}
                  alt=""
                  className="aspect-[16/10] w-full bg-sunken object-cover"
                />
              </a>
              <div className="flex items-center justify-between gap-2 px-3 py-2 text-2xs text-ink-faint">
                <span>{s.capturedAt ? new Date(s.capturedAt).toLocaleString() : '未知时间'}</span>
                {s.isLatest && (
                  <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-brand-ink">最新</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex h-40 items-center justify-center text-sm text-ink-faint">
          还没有快照
        </div>
      )}
    </Modal>

    <Modal
      open={showAddToCollection}
      onClose={() => setShowAddToCollection(false)}
      title="加入集合"
      size="sm"
      footer={
        <Button variant="ghost" onClick={() => setShowAddToCollection(false)}>
          完成
        </Button>
      }
    >
      <div className="flex flex-col gap-1">
        {(collections ?? []).length === 0 ? (
          <p className="px-1 py-6 text-center text-xs leading-relaxed text-ink-faint">
            还没有集合。先在「集合」页新建一个，再回来把书签归进去。
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto scrollbar-slim">
            {(collections ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    addToCollection.mutate(
                      { collectionId: c.id, bookmarkId: b.id },
                      {
                        onSuccess: () => {
                          toast.success(`已加入「${c.name}」`);
                          setShowAddToCollection(false);
                        },
                      },
                    );
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-surface-hover"
                >
                  <span
                    style={tagColorVars(c.colorIndex)}
                    className="h-4 w-4 shrink-0 rounded-full bg-[var(--tag-dot)]"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 text-2xs tabular-nums text-ink-faint">{c.count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
    </>
  );
}

export const BookmarkCard = memo(BookmarkCardBase);

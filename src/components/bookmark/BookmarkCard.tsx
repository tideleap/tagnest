import { memo } from 'react';
import {
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
  GripVertical,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Star,
  Trash2,
} from 'lucide-react';
import type { Bookmark } from '@shared/types';
import { cx } from '@/lib/cx';
import { displayHost, faviconFor, relativeTime } from '@/lib/url';
import { IconButton, Menu, TagChip, RemoteImage } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
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
 * Grid-card cover image.
 *
 * Only rendered when a `coverUrl` exists; a bookmark without one gets a calm
 * brand wash instead of a blank tile. The image gently scales on hover (zoom)
 * while the card lifts — a subtle but perceptible "peek closer" cue.
 */
function Cover({ bookmark }: { bookmark: Bookmark }) {
  if (!bookmark.coverUrl) {
    return (
      <div className="mb-3 -mx-4 -mt-4 flex h-28 items-center justify-center overflow-hidden rounded-t-lg bg-brand-soft/50">
        <FaviconBadge bookmark={bookmark} size={44} />
      </div>
    );
  }
  return (
    <div className="relative mb-3 -mx-4 -mt-4 h-32 overflow-hidden rounded-t-lg bg-sunken">
      <RemoteImage
        src={bookmark.coverUrl}
        alt=""
        className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
        fallback={<></>}
      />
    </div>
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
    <article
      className={cx(
        'group relative flex bg-surface',
        'card-lift border border-line hover:border-line-strong',
        isGrid
          ? 'h-full flex-col rounded-lg p-4'
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
          {/* ---- Non-grid: left favicon badge + stacked content.
                  Grid omits the left rail — the badge lives under the cover. */}
          {!isGrid && (
            <div className="flex shrink-0 flex-col items-center gap-1.5">
              {grip}
              <FaviconBadge bookmark={b} size={40} />
            </div>
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {isGrid && (
              <>
                <Cover bookmark={b} />
                <div className="mb-0.5 flex items-center gap-2">
                  <FaviconBadge bookmark={b} size={22} />
                  <span className="min-w-0 truncate text-2xs text-ink-faint">{displayHost(b.url)}</span>
                </div>
              </>
            )}

            <h3 className="min-w-0 font-medium leading-snug text-ink">
              <button
                type="button"
                onClick={open}
                className={cx(
                  'text-left underline-offset-2 transition-colors hover:text-brand-ink hover:underline',
                  isGrid ? 'line-clamp-2 text-sm' : 'line-clamp-2 text-sm',
                )}
              >
                {b.title || displayHost(b.url)}
              </button>
            </h3>

            {!isCompact && (b.description || b.note) && (
              <p className={cx('text-xs leading-relaxed text-ink-soft', isGrid ? 'line-clamp-2' : 'line-clamp-2')}>
                {b.note || b.description}
              </p>
            )}

            {/* Meta row — host · relative time · visits, kept on one muted line */}
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-faint">
              {!isGrid && <span className="truncate">{displayHost(b.url)}</span>}
              {!isGrid && <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-line-strong" aria-hidden />}
              <time dateTime={b.createdAt} className="shrink-0">
                {relativeTime(b.createdAt)}
              </time>
              {b.visitCount > 0 && !isCompact && (
                <>
                  <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-line-strong" aria-hidden />
                  <span className="shrink-0 tabular-nums">{b.visitCount} 次访问</span>
                </>
              )}
            </div>

            {b.tags.length > 0 && !isCompact && (
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {b.tags.slice(0, isGrid ? 3 : 4).map((tag) => (
                  <li key={tag.id}>
                    <TagChip
                      name={tag.name}
                      colorIndex={tag.colorIndex}
                      size="sm"
                      onClick={() => onTagClick(tag.id)}
                    />
                  </li>
                ))}
                {b.tags.length > (isGrid ? 3 : 4) && (
                  <li className="self-center text-2xs text-ink-faint">
                    +{b.tags.length - (isGrid ? 3 : 4)}
                  </li>
                )}
              </ul>
            )}
          </div>

          {/* Actions — bottom-right on grid (with divider), right on list */}
          <div
            className={cx(
              'flex shrink-0 items-center gap-0.5 self-start',
              isGrid && 'mt-2 justify-end border-t border-line pt-2.5',
            )}
          >
            {isGrid && grip}
            {star}
            {more}
          </div>
        </>
      )}

      {inTrash && b.deletedAt && (
        <span className="absolute bottom-1.5 right-2 text-2xs text-ink-faint">
          {relativeTime(b.deletedAt)}删除
        </span>
      )}
    </article>
  );
}

export const BookmarkCard = memo(BookmarkCardBase);

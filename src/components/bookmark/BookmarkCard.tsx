import { memo, useState } from 'react';
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
import { IconButton, Menu, TagChip } from '@/components/ui';
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
  /** Fired when the grip starts a drag; carries the bookmark id. */
  onDragStartCard?: (id: string) => void;
  /** True while another card is being dragged over this one — drives the ring. */
  isDragOver?: boolean;
}

function Favicon({ bookmark, size }: { bookmark: Bookmark; size: number }) {
  const [failed, setFailed] = useState(false);
  const src = bookmark.faviconUrl ?? faviconFor(bookmark.url);

  if (failed) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-sm bg-sunken text-2xs font-semibold uppercase text-ink-faint"
        style={{ width: size, height: size }}
        aria-hidden
      >
        {displayHost(bookmark.url).charAt(0)}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-sm bg-sunken object-contain"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Grid-card cover image (Q8d).
 *
 * Only rendered when a `coverUrl` exists — a bookmark without one keeps the
 * title-first layout rather than exposing a blank tiles wall. The fixed ratio
 * reserves space up front so rows don't jump as images stream in; a broken
 * cover falls back silently to the favicon row below it.
 */
function Cover({ bookmark }: { bookmark: Bookmark }) {
  const [failed, setFailed] = useState(false);
  if (!bookmark.coverUrl || failed) return null;
  return (
    <div className="mb-2.5 -mx-3.5 -mt-3.5 overflow-hidden rounded-t-md bg-sunken">
      <img
        src={bookmark.coverUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="aspect-[16/9] w-full object-cover"
      />
    </div>
  );
}

/**
 * One card, three densities.
 *
 * Keeping list/grid/compact in a single component is deliberate: three
 * separate card components is how the same bookmark ends up with three
 * different sets of actions.
 */
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

  /**
   * The handle is the only draggable element on the card — the rest stays
   * clickable for selection and opening. `touch-none` keeps mobile from
   * scrolling when the user means to grab it.
   */
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
      className="flex h-6 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-sunken hover:text-ink-soft active:cursor-grabbing"
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

  return (
    <article
      className={cx(
        'group relative flex bg-surface transition-colors',
        'border border-line hover:border-line-strong',
        isGrid ? 'h-full flex-col rounded-md p-3.5' : 'items-start rounded-md',
        isCompact ? 'gap-2.5 px-3 py-2' : !isGrid && 'gap-3 p-3.5',
        selected && 'border-brand bg-brand-soft/35',
        isDragOver && 'border-brand ring-2 ring-brand/50',
      )}
    >
      {/* Checkbox only materialises on hover or once a selection exists —
          otherwise it competes with the favicon for attention on every row. */}
      <label
        className={cx(
          'absolute left-1 top-1 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm transition-opacity',
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
          className="h-3.5 w-3.5 cursor-pointer rounded-sm border border-line-strong accent-[var(--color-brand)]"
        />
      </label>

      {!isGrid && (
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {grip}
          <Favicon bookmark={b} size={isCompact ? 16 : 20} />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {isGrid && (
          <>
            <Cover bookmark={b} />
            <div className="mb-1 flex items-center gap-2">
              <Favicon bookmark={b} size={18} />
              <span className="min-w-0 truncate text-2xs text-ink-faint">{displayHost(b.url)}</span>
            </div>
          </>
        )}

        <h3 className={cx('min-w-0 font-medium leading-snug text-ink', isCompact ? 'truncate text-sm' : 'line-clamp-2 text-sm')}>
          <button
            type="button"
            onClick={open}
            className="text-left underline-offset-2 hover:text-brand-ink hover:underline"
          >
            {b.title || displayHost(b.url)}
          </button>
        </h3>

        {!isCompact && (b.description || b.note) && (
          <p className="line-clamp-2 text-xs leading-relaxed text-ink-soft">
            {b.note || b.description}
          </p>
        )}

        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-ink-faint">
          {!isGrid && <span className="shrink-0">{displayHost(b.url)}</span>}
          {!isGrid && <span aria-hidden>·</span>}
          <time dateTime={b.createdAt} className="shrink-0">
            {relativeTime(b.createdAt)}
          </time>
          {b.visitCount > 0 && !isCompact && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">{b.visitCount} 次访问</span>
            </>
          )}
        </div>

        {b.tags.length > 0 && !isCompact && (
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {b.tags.slice(0, isGrid ? 3 : 5).map((tag) => (
              <li key={tag.id}>
                <TagChip
                  name={tag.name}
                  colorIndex={tag.colorIndex}
                  size="sm"
                  onClick={() => onTagClick(tag.id)}
                />
              </li>
            ))}
            {b.tags.length > (isGrid ? 3 : 5) && (
              <li className="self-center text-2xs text-ink-faint">
                +{b.tags.length - (isGrid ? 3 : 5)}
              </li>
            )}
          </ul>
        )}
      </div>

      <div
        className={cx(
          'flex shrink-0 items-center gap-0.5',
          isGrid && 'mt-2 justify-end border-t border-line pt-2',
        )}
      >
        {isGrid && grip}
        {!inTrash && (
          <IconButton
            label={b.isFavorite ? '取消收藏' : '收藏'}
            size="sm"
            pressed={b.isFavorite}
            icon={
              <Star
                size={15}
                className={b.isFavorite ? 'fill-caution text-caution' : ''}
                aria-hidden
              />
            }
            onClick={() => onToggleFavorite(b.id, !b.isFavorite)}
            className={cx(
              !b.isFavorite && 'opacity-0 focus:opacity-100 group-hover:opacity-100',
              'transition-opacity',
            )}
          />
        )}

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
      </div>

      {inTrash && b.deletedAt && (
        <span className="absolute bottom-1.5 right-2 text-2xs text-ink-faint">
          {relativeTime(b.deletedAt)}删除
        </span>
      )}
    </article>
  );
}

export const BookmarkCard = memo(BookmarkCardBase);

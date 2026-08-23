import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, FolderTree, Sparkles, Wand2 } from 'lucide-react';
import type { Bookmark, Tag } from '@shared/types';
import {
  buildPrimaryCategoryGroups,
  UNTAGGED_GROUP_ID,
  type CategoryGroup,
} from '@/lib/categoryGroups';
import { tagColorVars, Button } from '@/components/ui';
import { BookmarkCard, type BookmarkCardProps } from '@/components/bookmark/BookmarkCard';
import { cx } from '@/lib/cx';
import { useAssignCategory, useCategoryWriteback } from '@/hooks/queries/category';

/**
 * C2-3 — drag-to-reclassify.
 *
 * Every card is draggable; dropping one onto a category section (or its level-2
 * sub-section) re-assigns its PRIMARY category to that tag via `useAssignCategory`.
 * The bookmark id travels on the native drag payload (`text/plain`), set by
 * `BookmarkCard` on drag start, so the drop handler never needs a shared state
 * variable for the id — only `overTagId` for the highlight. Synthetic groups
 * (deleted-root path labels / the 未分类 catch-all) are not real tags, so they
 * reject drops.
 */

/**
 * Two-level category browse view for the Library.
 *
 * CategorySync (C2-1): this view renders the PRIMARY-category placement, not
 * the loose tag graph. Every bookmark appears exactly once — under the single
 * category it was assigned (`bookmark_primary_category`) — instead of under
 * every tag it carries. Placements are read from the writeback feed
 * (`/api/category/tree?format=writeback`), the same mapping the browser
 * extension consumes, so the view and the bookmark bar can never disagree.
 *
 * Bookmarks with no placement yet collect in the `__untagged` group, which
 * doubles as the C2-5 entry point: a "立即整理" button jumps straight to the
 * categorize organiser. Collapse state per group persists to localStorage.
 */

const STORAGE_KEY = 'tagnest.library.category-collapsed';

/** Cap on cards per sub-section before a "load more" control appears. */
const PER_SECTION_LIMIT = 12;

type CardHandlers = Omit<
  BookmarkCardProps,
  'bookmark' | 'view' | 'selected' | 'selectionActive' | 'draggable' | 'onDragStartCard' | 'isDragOver'
>;

export function CategoryView({
  bookmarks,
  tags,
  selected,
  selectionActive,
  handlers,
}: {
  bookmarks: Bookmark[];
  tags: Tag[];
  selected: Set<string>;
  selectionActive: boolean;
  handlers: CardHandlers;
}) {
  const navigate = useNavigate();
  const assignCategory = useAssignCategory();
  const [overTagId, setOverTagId] = useState<string | null>(null);

  // C2-3: the dragged bookmark id rides the native payload set by BookmarkCard,
  // so we only track the hovered target tag for highlighting.
  const handleDragStart = (id: string) => {
    setOverTagId(null);
    void id; // id is carried via dataTransfer; no extra state needed.
  };

  const handleDragOver = (tagId: string, e: React.DragEvent) => {
    if (tagId === UNTAGGED_GROUP_ID || tagId.startsWith('__path:')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overTagId !== tagId) setOverTagId(tagId);
  };

  const handleDrop = (tagId: string, e: React.DragEvent) => {
    if (  tagId === UNTAGGED_GROUP_ID || tagId.startsWith('__path:')) return;
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    setOverTagId(null);
    if (id) assignCategory.mutate({ bookmarkIds: [id], tagId });
  };

  // Primary placements come from the writeback feed. It is keyset-paged, so
  // pull every page before grouping — a partial map would misfile bookmarks
  // whose placement lives on a later page as 未分类.
  const { data: writeback, hasNextPage, isFetchingNextPage, fetchNextPage } = useCategoryWriteback();

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const primaryCategoryByBookmark = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const page of writeback?.pages ?? []) {
      for (const item of page.items) {
        if (item.categoryPath && item.categoryPath.length > 0) {
          map.set(item.bookmarkId, item.categoryPath);
        }
      }
    }
    return map;
  }, [writeback]);

  const groups = useMemo(
    () => buildPrimaryCategoryGroups(tags, bookmarks, primaryCategoryByBookmark),
    [tags, bookmarks, primaryCategoryByBookmark],
  );

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
    } catch {
      /* quota / private mode — ignore */
    }
  }, [collapsed]);

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand-accent shadow-raised">
          <FolderTree size={22} aria-hidden />
        </span>
        <h3 className="atelier-display atelier-display--3 text-ink">还没有可浏览的分类</h3>
        <p className="max-w-sm text-sm leading-relaxed text-ink-soft">
          运行一次「精确分类」，书签会按唯一主分类整理在这里。
        </p>
        <Button
          variant="primary"
          iconLeft={<Wand2 size={15} />}
          onClick={() => navigate('/organize?mode=category')}
        >
          立即整理
        </Button>
      </div>
    );
  }

  const toggle = (id: string) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <CategorySection
          key={group.id}
          group={group}
          collapsed={collapsed[group.id] === true}
          onToggle={() => toggle(group.id)}
          selected={selected}
          selectionActive={selectionActive}
          handlers={handlers}
          onOrganizeUntagged={() => navigate('/organize?mode=category')}
          draggable
          onDragStartCard={handleDragStart}
          onDragOverTag={handleDragOver}
          onDropTag={handleDrop}
          overTagId={overTagId}
        />
      ))}
    </div>
  );
}

function CategorySection({
  group,
  collapsed,
  onToggle,
  selected,
  selectionActive,
  handlers,
  onOrganizeUntagged,
  draggable,
  onDragStartCard,
  onDragOverTag,
  onDropTag,
  overTagId,
}: {
  group: CategoryGroup;
  collapsed: boolean;
  onToggle: () => void;
  selected: Set<string>;
  selectionActive: boolean;
  handlers: CardHandlers;
  /** C2-5 — jump to the categorize organiser from the 未分类 group. */
  onOrganizeUntagged: () => void;
  draggable: boolean;
  onDragStartCard: (id: string) => void;
  onDragOverTag: (tagId: string, e: React.DragEvent) => void;
  onDropTag: (tagId: string, e: React.DragEvent) => void;
  overTagId: string | null;
}) {
  const isUntagged = group.id === UNTAGGED_GROUP_ID;
  const isDropTarget = overTagId === group.id;
  const totalCount =
    group.directItems.length + group.children.reduce((s, c) => s + c.items.length, 0);

  return (
    <section
      className={cx(
        'rounded-xl border bg-surface/70 backdrop-blur-sm transition-colors',
        isDropTarget ? 'border-brand ring-2 ring-brand/40' : 'border-line',
      )}
      aria-labelledby={`category-${group.id}`}
      onDragOver={!isUntagged ? (e) => onDragOverTag(group.id, e) : undefined}
      onDrop={!isUntagged ? (e) => onDropTag(group.id, e) : undefined}
    >
      {/* Group header — name, colour accent, counts, collapse control. */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <ChevronDown
            size={15}
            aria-hidden
            className={cx('shrink-0 text-ink-faint transition-transform', collapsed && '-rotate-90')}
          />
          {!isUntagged ? (
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ ...tagColorVars(group.colorIndex), background: 'var(--tag-dot)' }}
            />
          ) : (
            <Sparkles size={14} aria-hidden className="shrink-0 text-ink-faint" />
          )}
          <h2
            id={`category-${group.id}`}
            className="min-w-0 truncate text-sm font-semibold text-ink"
          >
            {group.name}
          </h2>
          <span className="shrink-0 text-2xs tabular-nums text-ink-faint">
            {group.children.length > 0 && `${group.children.length} 个子类 · `}
            {totalCount} 个书签
          </span>
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-2xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
        >
          {collapsed ? (
            <>
              <ChevronDown size={12} aria-hidden />
              展开
            </>
          ) : (
            <>
              <ChevronUp size={12} aria-hidden />
              收起
            </>
          )}
        </button>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-5 px-4 py-4">
          {/* Level 2: child-tag sub-sections first… */}
          {group.children.map((child) => (
            <SubSection
              key={child.id}
              title={child.name}
              colorIndex={child.colorIndex}
              items={child.items}
              selected={selected}
              selectionActive={selectionActive}
              handlers={handlers}
              draggable={draggable}
              onDragStartCard={onDragStartCard}
              onDragOverTag={onDragOverTag}
              onDropTag={onDropTag}
              overTagId={overTagId}
              tagId={child.id}
            />
          ))}

          {/* …then the group's direct bookmarks. */}
          {group.directItems.length > 0 && (
            <SubSection
              title={isUntagged ? '尚未分类' : '直接归类'}
              items={group.directItems}
              untagged={isUntagged}
              selected={selected}
              selectionActive={selectionActive}
              handlers={handlers}
              draggable={draggable}
              onDragStartCard={onDragStartCard}
              onDragOverTag={onDragOverTag}
              onDropTag={onDropTag}
              overTagId={overTagId}
              tagId={group.id}
            />
          )}

          {isUntagged && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line bg-sunken/60 px-4 py-3">
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-soft">
                这些书签还没有主分类。运行一次「精确分类」，AI
                会为每条书签指定唯一归属，确认后即写入。
              </p>
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<Wand2 size={14} />}
                onClick={onOrganizeUntagged}
              >
                立即整理
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One level-2 bucket: a small title bar plus a responsive card grid. Items
 * beyond the cap hide behind a "load more" control so a huge bucket cannot
 * blow up the page.
 */
function SubSection({
  title,
  colorIndex,
  items,
  untagged,
  selected,
  selectionActive,
  handlers,
  draggable,
  onDragStartCard,
  onDragOverTag,
  onDropTag,
  overTagId,
  tagId,
}: {
  title: string;
  colorIndex?: number;
  items: Bookmark[];
  untagged?: boolean;
  selected: Set<string>;
  selectionActive: boolean;
  handlers: CardHandlers;
  draggable: boolean;
  onDragStartCard: (id: string) => void;
  onDragOverTag: (tagId: string, e: React.DragEvent) => void;
  onDropTag: (tagId: string, e: React.DragEvent) => void;
  overTagId: string | null;
  /** Real tag id this bucket maps to (drop target); absent only for 未分类. */
  tagId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = items.length > PER_SECTION_LIMIT;
  const visible = expanded ? items : items.slice(0, PER_SECTION_LIMIT);
  const isDropTarget = tagId !== undefined && overTagId === tagId;

  // A level-2 bucket is itself a drop target. stopPropagation keeps a drop on a
  // child bucket from bubbling to the parent section and landing on the parent
  // tag instead of the child.
  const childHandlers = tagId
    ? {
        onDragOver: (e: React.DragEvent) => {
          e.stopPropagation();
          onDragOverTag(tagId, e);
        },
        onDrop: (e: React.DragEvent) => {
          e.stopPropagation();
          onDropTag(tagId, e);
        },
      }
    : {};

  return (
    <div
      {...childHandlers}
      className={cx(
        'rounded-lg transition-colors',
        isDropTarget && 'bg-brand-soft/50 ring-1 ring-brand/40',
      )}
    >
      <div className="mb-2.5 flex items-center gap-2">
        {!untagged && colorIndex !== undefined && (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ ...tagColorVars(colorIndex), background: 'var(--tag-dot)' }}
          />
        )}
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-soft">{title}</h3>
        <span className="text-2xs tabular-nums text-ink-faint">{items.length}</span>
      </div>

      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visible.map((b) => (
          <li key={b.id}>
            <BookmarkCard
              bookmark={b}
              view="grid"
              selected={selected.has(b.id)}
              selectionActive={selectionActive}
              draggable={draggable}
              onDragStartCard={onDragStartCard}
              {...handlers}
            />
          </li>
        ))}
      </ul>

      {hasMore && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-2xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            {expanded ? (
              <>
                <ChevronUp size={11} aria-hidden />
                收起多余 {items.length - PER_SECTION_LIMIT} 个
              </>
            ) : (
              <>
                <ChevronDown size={11} aria-hidden />
                加载更多（还有 {items.length - PER_SECTION_LIMIT} 个）
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

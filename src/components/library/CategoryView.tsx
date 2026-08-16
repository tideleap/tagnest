import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, FolderTree, Sparkles } from 'lucide-react';
import type { Bookmark, Tag } from '@shared/types';
import { buildCategoryGroups, UNTAGGED_GROUP_ID, type CategoryGroup } from '@/lib/categoryGroups';
import { tagColorVars } from '@/components/ui';
import { BookmarkCard, type BookmarkCardProps } from '@/components/bookmark/BookmarkCard';
import { cx } from '@/lib/cx';

/**
 * Two-level category browse view for the Library.
 *
 * Level 1 groups are top-level tags; each group expands into its child-tag
 * sub-sections first and its direct bookmarks after — the same shape the
 * `directory` share theme renders, but built client-side from the live
 * library so every card keeps its full interaction surface (select, edit,
 * favourite, …). Collapse state per group persists to localStorage.
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
  const groups = useMemo(() => buildCategoryGroups(tags, bookmarks), [tags, bookmarks]);

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
          给书签打上标签后，它们会按一级、二级分类整理在这里。
        </p>
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
}: {
  group: CategoryGroup;
  collapsed: boolean;
  onToggle: () => void;
  selected: Set<string>;
  selectionActive: boolean;
  handlers: CardHandlers;
}) {
  const isUntagged = group.id === UNTAGGED_GROUP_ID;
  const totalCount =
    group.directItems.length + group.children.reduce((s, c) => s + c.items.length, 0);

  return (
    <section
      className="rounded-xl border border-line bg-surface/70 backdrop-blur-sm"
      aria-labelledby={`category-${group.id}`}
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
            />
          ))}

          {/* …then the group's direct bookmarks. */}
          {group.directItems.length > 0 && (
            <SubSection
              title={isUntagged ? '尚未打标签' : '直接归类'}
              items={group.directItems}
              untagged={isUntagged}
              selected={selected}
              selectionActive={selectionActive}
              handlers={handlers}
            />
          )}

          {isUntagged && (
            <p className="rounded-md border border-dashed border-line bg-sunken/60 px-4 py-3 text-xs leading-relaxed text-ink-soft">
              这些书签还没有分类标签。选中它们并打上标签，即可归入对应分组。
            </p>
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
}: {
  title: string;
  colorIndex?: number;
  items: Bookmark[];
  untagged?: boolean;
  selected: Set<string>;
  selectionActive: boolean;
  handlers: CardHandlers;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = items.length > PER_SECTION_LIMIT;
  const visible = expanded ? items : items.slice(0, PER_SECTION_LIMIT);

  return (
    <div>
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

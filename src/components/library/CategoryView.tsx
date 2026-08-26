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
import { cx } from '@/lib/cx';
import { useCategoryWriteback } from '@/hooks/queries/category';
import { NavigationTile } from './NavigationTile';

/**
 * Website-navigation style browse view for the Library.
 *
 * Bookmarks are grouped by their PRIMARY category — the same placement the
 * bookmark bar and the browser extension consume, read from the writeback feed
 * — so the view can never disagree with what lands in the toolbar.
 *
 * Each category becomes a section; inside it, bookmarks render as compact
 * favicon tiles (a "site navigation" grid) instead of management cards. The
 * goal here is fast visual scanning and one-click open, not bulk edits.
 * Untagged bookmarks collect in a catch-all section with a "立即整理" entry
 * point into the categoriser.
 */

const STORAGE_KEY = 'tagnest.library.category-collapsed';

/** Cap on tiles per sub-section before a "load more" control appears. */
const PER_SECTION_LIMIT = 18;

export function CategoryView({
  bookmarks,
  tags,
}: {
  bookmarks: Bookmark[];
  tags: Tag[];
}) {
  const navigate = useNavigate();

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
          onOrganizeUntagged={() => navigate('/organize?mode=category')}
        />
      ))}
    </div>
  );
}

function CategorySection({
  group,
  collapsed,
  onToggle,
  onOrganizeUntagged,
}: {
  group: CategoryGroup;
  collapsed: boolean;
  onToggle: () => void;
  /** Jump to the categorize organiser from the 未分类 group. */
  onOrganizeUntagged: () => void;
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
            />
          ))}

          {/* …then the group's direct bookmarks. */}
          {group.directItems.length > 0 && (
            <SubSection
              title={isUntagged ? '尚未分类' : '直接归类'}
              items={group.directItems}
              untagged={isUntagged}
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
 * One level-2 bucket: a small title bar plus a dense favicon-tile grid. Items
 * beyond the cap hide behind a "load more" control so a huge bucket cannot
 * blow up the page.
 */
function SubSection({
  title,
  colorIndex,
  items,
  untagged,
}: {
  title: string;
  colorIndex?: number;
  items: Bookmark[];
  untagged?: boolean;
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

      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {visible.map((b) => (
          <li key={b.id}>
            <NavigationTile bookmark={b} />
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

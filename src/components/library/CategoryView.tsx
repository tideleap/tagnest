import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Flame, FolderTree, Hash, Sparkles, Wand2 } from 'lucide-react';
import type { Bookmark, Tag } from '@shared/types';
import {
  buildPrimaryCategoryGroups,
  UNTAGGED_GROUP_ID,
  type CategoryGroup,
} from '@/lib/categoryGroups';
import { tagColorVars, Button } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useCategoryWriteback } from '@/hooks/queries/category';
import { useRecordVisit } from '@/hooks/queries';
import { displayHost } from '@/lib/url';
import { NavigationTile } from './NavigationTile';

/**
 * Website-navigation style browse view for the Library — arranged like a
 * portal directory (Sogou-style):
 *
 *   1. A horizontal category tab bar (全部 + each top-level category).
 *   2. A left "热搜排行榜" rail: the most-visited bookmarks in the current
 *      scope (whole library on 全部, or just the open category).
 *   3. A main grid of favicon tiles, grouped by sub-category.
 *   4. A bottom "热门标签" rail: sub-category chips (in a category) or the
 *      top-level categories (on 全部) that jump / filter the view.
 *
 * Bookmarks are grouped by their PRIMARY category — the same placement the
 * bookmark bar and the browser extension consume, read from the writeback feed
 * — so the view can never disagree with what lands in the toolbar. Each tile
 * is a compact "site navigation" cell (see NavigationTile) for fast scanning
 * and one-click open, not bulk management.
 */

const ALL_TAB = '__all__';
/** Cap on tiles per sub-section before a "load more" control appears. */
const PER_SECTION_LIMIT = 18;
/** Number of rows in the left hot-search rail. */
const HOT_LIMIT = 8;

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

  const [activeTab, setActiveTab] = useState<string>(ALL_TAB);
  const [childFilter, setChildFilter] = useState<string | null>(null);

  // Drop the selection if the data refresh retires the open category.
  useEffect(() => {
    if (activeTab !== ALL_TAB && !groups.some((g) => g.id === activeTab)) {
      setActiveTab(ALL_TAB);
      setChildFilter(null);
    }
  }, [groups, activeTab]);

  const activeGroup = activeTab === ALL_TAB ? null : groups.find((g) => g.id === activeTab) ?? null;

  // Bookmarks in the current scope: everything for 全部, or just this category.
  const scopeBookmarks = useMemo(() => {
    if (!activeGroup) return bookmarks;
    return [...activeGroup.directItems, ...activeGroup.children.flatMap((c) => c.items)];
  }, [activeGroup, bookmarks]);

  // Hot ranking: most-visited first, recent as tiebreak.
  const hotBookmarks = useMemo(() => {
    return [...scopeBookmarks]
      .sort(
        (a, b) =>
          (b.visitCount ?? 0) - (a.visitCount ?? 0) ||
          (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
      )
      .slice(0, HOT_LIMIT);
  }, [scopeBookmarks]);

  // Bottom rail: sub-categories of the open group, or every top-level category.
  const hotTags = useMemo(() => {
    if (!activeGroup) return groups.filter((g) => g.id !== UNTAGGED_GROUP_ID);
    return activeGroup.children;
  }, [activeGroup, groups]);

  const selectTab = (id: string) => {
    setActiveTab(id);
    setChildFilter(null);
  };

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

  return (
    <div className="flex flex-col gap-5">
      {/* Category tab bar (sticky) */}
      <div className="sticky top-0 z-10 -mx-1 flex gap-1.5 overflow-x-auto border-b border-line bg-glass-canvas/85 px-1 py-2 backdrop-blur">
        <TabPill active={activeTab === ALL_TAB} onClick={() => selectTab(ALL_TAB)}>
          全部
        </TabPill>
        {groups.map((g) => (
          <TabPill
            key={g.id}
            active={activeTab === g.id}
            colorIndex={g.colorIndex}
            onClick={() => selectTab(g.id)}
          >
            {g.name}
          </TabPill>
        ))}
      </div>

      {/* Body: hot rail + site grid */}
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <aside className="lg:w-60 lg:shrink-0">
          <HotRanking items={hotBookmarks} />
        </aside>
        <div className="min-w-0 flex-1">
          {activeGroup ? (
            <CategoryDetail
              group={activeGroup}
              childFilter={childFilter}
              onClearFilter={() => setChildFilter(null)}
              onOrganize={() => navigate('/organize?mode=category')}
            />
          ) : (
            <AllCategories groups={groups} onOpenTab={selectTab} onOrganize={() => navigate('/organize?mode=category')} />
          )}
        </div>
      </div>

      {/* Bottom hot tags / categories rail */}
      {hotTags.length > 0 && (
        <div className="border-t border-line pt-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
            <Hash size={13} className="text-brand-accent" aria-hidden />
            {activeGroup ? '热门标签' : '全部分类'}
          </div>
          <div className="flex flex-wrap gap-2">
            {hotTags.map((t) => {
              const isChildActive = activeGroup ? childFilter === t.id : false;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => (activeGroup ? setChildFilter(isChildActive ? null : t.id) : selectTab(t.id))}
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                    isChildActive
                      ? 'border-brand bg-brand-soft text-brand-ink'
                      : 'border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink',
                  )}
                >
                  {activeGroup && (
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ ...tagColorVars(t.colorIndex), background: 'var(--tag-dot)' }}
                      aria-hidden
                    />
                  )}
                  {t.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tab bar
 * ------------------------------------------------------------------ */

function TabPill({
  active,
  colorIndex,
  onClick,
  children,
}: {
  active: boolean;
  colorIndex?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors',
        active ? 'bg-brand text-on-brand shadow-xs' : 'bg-surface text-ink-soft hover:bg-sunken hover:text-ink',
      )}
    >
      {colorIndex !== undefined && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ ...tagColorVars(colorIndex), background: 'var(--tag-dot)' }}
          aria-hidden
        />
      )}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Left hot-search rail
 * ------------------------------------------------------------------ */

function HotRanking({ items }: { items: Bookmark[] }) {
  const recordVisit = useRecordVisit();

  return (
    <div className="rounded-xl border border-line bg-surface/70 p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <Flame size={15} className="text-brand-accent" aria-hidden />
        <h3 className="text-sm font-semibold text-ink">全网热搜榜</h3>
      </div>
      {items.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-faint">
          还没有访问记录。打开书签后，这里会按访问频次排出热门站点。
        </p>
      ) : (
        <ol className="space-y-0.5">
          {items.map((b, i) => (
            <li key={b.id}>
              <a
                href={b.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  recordVisit.mutate(b.id);
                  window.open(b.url, '_blank', 'noopener,noreferrer');
                }}
                className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-sunken"
                title={b.title || displayHost(b.url)}
              >
                <span
                  className={cx(
                    'w-4 shrink-0 text-center text-xs tabular-nums',
                    i < 3 ? 'font-semibold text-brand' : 'text-ink-faint',
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-soft group-hover:text-ink">
                  {b.title || displayHost(b.url)}
                </span>
                {i === 0 && (
                  <span className="shrink-0 rounded bg-critical-soft px-1 text-[10px] font-medium text-critical-ink">
                    热
                  </span>
                )}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 全部 tab — every category as a block
 * ------------------------------------------------------------------ */

function AllCategories({
  groups,
  onOpenTab,
  onOrganize,
}: {
  groups: CategoryGroup[];
  onOpenTab: (id: string) => void;
  onOrganize: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) =>
        g.id === UNTAGGED_GROUP_ID ? (
          <UntaggedBlock key={g.id} group={g} onOrganize={onOrganize} />
        ) : (
          <CategoryBlock key={g.id} group={g} onOpen={() => onOpenTab(g.id)} />
        ),
      )}
    </div>
  );
}

function CategoryBlock({ group, onOpen }: { group: CategoryGroup; onOpen: () => void }) {
  const items = useMemo(
    () => [...group.directItems, ...group.children.flatMap((c) => c.items)],
    [group],
  );

  return (
    <section className="rounded-xl border border-line bg-surface/70">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 border-b border-line px-4 py-3 text-left transition-colors hover:bg-sunken/60"
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-sm"
          style={{ ...tagColorVars(group.colorIndex), background: 'var(--tag-dot)' }}
          aria-hidden
        />
        <h2 className="text-sm font-semibold text-ink">{group.name}</h2>
        <span className="text-2xs tabular-nums text-ink-faint">{items.length} 个书签</span>
        <ChevronRight size={14} className="ml-auto shrink-0 text-ink-faint" aria-hidden />
      </button>
      <div className="px-4 py-4">
        <SiteGrid items={items} />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Single category tab — sub-sections + child filter
 * ------------------------------------------------------------------ */

function CategoryDetail({
  group,
  childFilter,
  onClearFilter,
  onOrganize,
}: {
  group: CategoryGroup;
  childFilter: string | null;
  onClearFilter: () => void;
  onOrganize: () => void;
}) {
  const isUntagged = group.id === UNTAGGED_GROUP_ID;
  const children = childFilter ? group.children.filter((c) => c.id === childFilter) : group.children;

  return (
    <div className="flex flex-col gap-5">
      {childFilter && (
        <button
          type="button"
          onClick={onClearFilter}
          className="inline-flex w-fit items-center gap-1 rounded-full border border-line px-2.5 py-1 text-2xs text-ink-soft transition-colors hover:text-ink"
        >
          <ChevronRight size={12} className="rotate-180" aria-hidden />
          返回「{group.name}」全部
        </button>
      )}

      {children.map((child) => (
        <SubSection key={child.id} title={child.name} colorIndex={child.colorIndex} items={child.items} />
      ))}

      {group.directItems.length > 0 && (
        <SubSection title={isUntagged ? '尚未分类' : '常用站点'} items={group.directItems} untagged={isUntagged} />
      )}

      {isUntagged && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line bg-sunken/60 px-4 py-3">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-soft">
            这些书签还没有主分类。运行一次「精确分类」，AI 会为每条书签指定唯一归属，确认后即写入。
          </p>
          <Button size="sm" variant="secondary" iconLeft={<Wand2 size={14} />} onClick={onOrganize}>
            立即整理
          </Button>
        </div>
      )}
    </div>
  );
}

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
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2">
        {!untagged && colorIndex !== undefined && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ ...tagColorVars(colorIndex), background: 'var(--tag-dot)' }}
            aria-hidden
          />
        )}
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-soft">{title}</h3>
        <span className="text-2xs tabular-nums text-ink-faint">{items.length}</span>
      </div>
      <SiteGrid items={items} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared: dense favicon-tile grid with a "load more" cap
 * ------------------------------------------------------------------ */

function SiteGrid({ items }: { items: Bookmark[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = items.length > PER_SECTION_LIMIT;
  const visible = expanded ? items : items.slice(0, PER_SECTION_LIMIT);

  if (items.length === 0) return <p className="text-xs text-ink-faint">该分类下暂无书签。</p>;

  return (
    <div>
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
            {expanded ? '收起多余' : `加载更多（还有 ${items.length - PER_SECTION_LIMIT} 个）`}
          </button>
        </div>
      )}
    </div>
  );
}

function UntaggedBlock({ group, onOrganize }: { group: CategoryGroup; onOrganize: () => void }) {
  const items = group.directItems;
  return (
    <section className="rounded-xl border border-line bg-surface/70">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <Sparkles size={14} className="shrink-0 text-ink-faint" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">{group.name}</h2>
        <span className="text-2xs tabular-nums text-ink-faint">{items.length} 个书签</span>
      </div>
      <div className="px-4 py-4">
        <SiteGrid items={items} />
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line bg-sunken/60 px-4 py-3">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-soft">
            这些书签还没有主分类。运行一次「精确分类」，AI 会为每条书签指定唯一归属。
          </p>
          <Button size="sm" variant="secondary" iconLeft={<Wand2 size={14} />} onClick={onOrganize}>
            立即整理
          </Button>
        </div>
      </div>
    </section>
  );
}

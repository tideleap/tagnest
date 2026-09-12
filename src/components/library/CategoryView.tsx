import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  ChevronRight,
  Clock,
  Flame,
  FolderTree,
  Hash,
  Layers,
  Pin,
  PinOff,
  PlusCircle,
  Search,
  Sparkles,
  Wand2,
  Zap,
} from 'lucide-react';
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
import './CategoryView.css';

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
 *
 * On the "全部" tab the directory is enriched with a greeting Hero, a
 * frequently-visited quick-access strip, and a recently-added strip. Inside a
 * single category an instant in-category search filters the tiles.
 *
 * Visuals live in `./CategoryView.css`: a vivid gradient Hero with a drifting
 * glow, colour-accented category blocks, glass stat cards and staggered
 * entrance / hover micro-motion (all gated by prefers-reduced-motion).
 */

const ALL_TAB = '__all__';
/** Cap on tiles per sub-section before a "load more" control appears. */
const PER_SECTION_LIMIT = 18;
/** Number of rows in the left hot-search rail. */
const HOT_LIMIT = 8;
/** How many bookmarks the quick-access / recent strips surface. */
const QUICK_LIMIT = 8;
/** localStorage key holding the pinned quick-access bookmark ids. */
const PINNED_STORAGE_KEY = 'tagnest.pinnedQuickAccess';

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** Time-of-day greeting for the Hero banner. */
function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 11) return '早上好';
  if (hour >= 11 && hour < 13) return '中午好';
  if (hour >= 13 && hour < 18) return '下午好';
  if (hour >= 18 && hour < 23) return '晚上好';
  return '深夜好';
}

/** True when `iso` falls on the same calendar day as `now` (local time). */
function isSameDayIso(iso: string, now: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

const CATEGORY_EMOJIS = ['📁', '🌐', '🛠️', '🎨', '📚', '🎮', '📰', '💡', '🍔', '🎵', '🏷️', '🚀'];

/** Deterministic emoji for a category name (stable across renders). */
function categoryEmoji(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return CATEGORY_EMOJIS[hash % CATEGORY_EMOJIS.length];
}

/** Read the pinned quick-access ids from localStorage (resilient to junk). */
function loadPinnedIds(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Persist the pinned quick-access ids to localStorage (best-effort). */
function savePinnedIds(ids: string[]): void {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* storage may be unavailable (private mode / quota) — ignore */
  }
}

/** Case-insensitive match of a bookmark against a search needle. */
function matchesQuery(b: Bookmark, needle: string): boolean {
  const hay = [b.title, b.url, displayHost(b.url)].join(' ').toLowerCase();
  return hay.includes(needle);
}

/** Filter bookmarks by needle; empty needle returns the list untouched. */
function filterItems(items: Bookmark[], needle: string): Bookmark[] {
  if (!needle) return items;
  return items.filter((b) => matchesQuery(b, needle));
}

/** Sort by visit count descending; missing counts fall back to createdAt recency. */
function sortByPopularity(a: Bookmark, b: Bookmark): number {
  return (
    (b.visitCount ?? 0) - (a.visitCount ?? 0) ||
    (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  );
}

/**
 * Pick the bookmarks to surface in the quick-access strip:
 * pinned ids are always shown first (in pin order), then the most-visited
 * bookmarks fill up to QUICK_LIMIT. If more ids are pinned than the limit,
 * every pinned bookmark is still shown.
 */
function pickQuickAccess(bookmarks: Bookmark[], pinnedIds: string[]): Bookmark[] {
  const pinnedSet = new Set(pinnedIds);
  const pinned = pinnedIds
    .map((id) => bookmarks.find((b) => b.id === id))
    .filter((b): b is Bookmark => Boolean(b));
  const rest = bookmarks.filter((b) => !pinnedSet.has(b.id)).sort(sortByPopularity);
  const combined = [...pinned, ...rest];
  const max = pinned.length >= QUICK_LIMIT ? pinned.length : QUICK_LIMIT;
  return combined.slice(0, max);
}

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
  // Instant in-category search query (single-category tab only).
  const [categorySearch, setCategorySearch] = useState<string>('');

  // Drop the selection if the data refresh retires the open category.
  useEffect(() => {
    if (activeTab !== ALL_TAB && !groups.some((g) => g.id === activeTab)) {
      setActiveTab(ALL_TAB);
      setChildFilter(null);
      setCategorySearch('');
    }
  }, [groups, activeTab]);

  const selectTab = (id: string) => {
    setActiveTab(id);
    setChildFilter(null);
    setCategorySearch('');
  };

  const activeGroup = activeTab === ALL_TAB ? null : groups.find((g) => g.id === activeTab) ?? null;

  // Hero statistics, derived entirely from the bookmarks prop.
  const stats = useMemo(() => {
    const now = new Date();
    let addedToday = 0;
    let weekVisits = 0;
    for (const b of bookmarks) {
      if (b.createdAt && isSameDayIso(b.createdAt, now)) addedToday += 1;
      weekVisits += b.visitCount ?? 0;
    }
    return { total: bookmarks.length, addedToday, weekVisits };
  }, [bookmarks]);

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
    <div className="flex flex-col gap-3">
      {/* Category tab bar (sticky) */}
      <div className="sticky top-0 z-10 -mx-1 flex gap-1.5 overflow-x-auto border-b border-line bg-glass-canvas px-1 py-2 backdrop-blur">
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

      {/* Content — keyed by tab so the entrance stagger replays on switch. */}
      <div key={activeTab} className="cat-enter flex flex-col gap-3">
        {activeGroup ? (
          <>
            {/* Instant in-category search (single category tab only) */}
            <CategoryInternalSearch value={categorySearch} onChange={setCategorySearch} />

            {/* Body: hot rail + site grid */}
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
              <aside className="lg:w-60 lg:shrink-0">
                <HotRanking items={hotBookmarks} />
              </aside>
              <div className="min-w-0 flex-1">
                <CategoryDetail
                  group={activeGroup}
                  childFilter={childFilter}
                  searchQuery={categorySearch}
                  onClearFilter={() => setChildFilter(null)}
                  onOrganize={() => navigate('/organize?mode=category')}
                />
              </div>
            </div>
          </>
        ) : (
          <>
            {/* 全部 tab — Hero + quick access + recent + directory */}
            <Hero total={stats.total} addedToday={stats.addedToday} weekVisits={stats.weekVisits} />
            <QuickAccess bookmarks={bookmarks} />
            <RecentAdditions bookmarks={bookmarks} />

            {/* Body: hot rail + site grid */}
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
              <aside className="lg:w-60 lg:shrink-0">
                <HotRanking items={hotBookmarks} />
              </aside>
              <div className="min-w-0 flex-1">
                <AllCategories
                  groups={groups}
                  onOpenTab={selectTab}
                  onOrganize={() => navigate('/organize?mode=category')}
                />
              </div>
            </div>
          </>
        )}

        {/* Bottom hot tags / categories rail */}
        {hotTags.length > 0 && (
          <div className="cat-section p-3">
            <div className="mb-2 flex items-center gap-1.5 px-1">
              <Hash size={13} className="text-brand-accent" aria-hidden />
              <span className="text-xs font-semibold text-ink-soft">
                {activeGroup ? '热门标签' : '全部分类'}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {hotTags.map((t) => {
                const isChildActive = activeGroup ? childFilter === t.id : false;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => (activeGroup ? setChildFilter(isChildActive ? null : t.id) : selectTab(t.id))}
                    className={cx('cat-chip focus-ring', isChildActive ? 'cat-chip-active' : 'cat-chip-inactive')}
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
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Hero welcome banner + statistics
 * ------------------------------------------------------------------ */

function Hero({ total, addedToday, weekVisits }: { total: number; addedToday: number; weekVisits: number }) {
  const greeting = greetingFor(new Date().getHours());
  return (
    <section className="cat-hero px-5 py-4">
      <div className="cat-hero-glow" aria-hidden />
      <div className="relative flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h2 className="atelier-display atelier-display--3 text-ink">{greeting}</h2>
          <p className="mt-1 text-sm text-ink-soft">今天也整理好你的导航</p>
        </div>
        <div className="flex gap-2">
          <StatCard label="总书签" value={total} icon={<Layers size={15} aria-hidden />} />
          <StatCard label="今日新增" value={addedToday} icon={<PlusCircle size={15} aria-hidden />} />
          <StatCard label="本周访问" value={weekVisits} icon={<Activity size={15} aria-hidden />} />
        </div>
      </div>
    </section>
  );
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <div className="cat-stat-card">
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-soft text-brand-accent" aria-hidden>
        {icon}
      </span>
      <span className="text-base font-semibold tabular-nums text-ink">{value}</span>
      <span className="text-2xs text-ink-muted">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Quick-access strip (frequently / recently visited, with pinning)
 * ------------------------------------------------------------------ */

function QuickAccess({ bookmarks }: { bookmarks: Bookmark[] }) {
  const recordVisit = useRecordVisit();
  const [pinnedIds, setPinnedIds] = useState<string[]>(loadPinnedIds);

  const setPinned = (next: string[]) => {
    savePinnedIds(next);
    setPinnedIds(next);
  };

  const items = useMemo(() => pickQuickAccess(bookmarks, pinnedIds), [bookmarks, pinnedIds]);

  const togglePin = (id: string) => {
    setPinned(pinnedIds.includes(id) ? pinnedIds.filter((p) => p !== id) : [...pinnedIds, id]);
  };

  const clearPins = () => setPinned([]);

  return (
    <section className="cat-section p-3">
      <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-1.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-soft text-brand-accent">
            <Zap size={13} aria-hidden />
          </span>
          <h2 className="font-display text-panel font-semibold tracking-tight text-ink">常用 / 最近访问</h2>
        </div>
        {pinnedIds.length > 0 && (
          <button
            type="button"
            onClick={clearPins}
            aria-label="清空固定"
            className="focus-ring hit-area-lg text-2xs text-ink-soft transition-colors hover:text-ink"
          >
            管理
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-1 text-xs leading-relaxed text-ink-muted">
          还没有书签，添加一些网站后再来这里。
        </p>
      ) : (
        <div className="flex snap-x gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
          {items.map((b) => (
            <QuickAccessCard
              key={b.id}
              bookmark={b}
              pinned={pinnedIds.includes(b.id)}
              onTogglePin={togglePin}
              onOpen={() => {
                recordVisit.mutate(b.id);
                window.open(b.url, '_blank', 'noopener,noreferrer');
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function QuickAccessCard({
  bookmark: b,
  pinned,
  onTogglePin,
  onOpen,
}: {
  bookmark: Bookmark;
  pinned: boolean;
  onTogglePin: (id: string) => void;
  onOpen: (url: string) => void;
}) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const title = b.title || displayHost(b.url);
  const host = displayHost(b.url);
  const faviconSrc = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;

  return (
    <div className="cat-tile cat-qa-card group relative snap-start">
      <button
        type="button"
        onClick={() => onTogglePin(b.id)}
        aria-label={pinned ? `取消固定 ${title}` : `固定 ${title}`}
        className="focus-ring hit-area-lg absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
      >
        {pinned ? <PinOff size={14} className="text-brand" /> : <Pin size={14} />}
      </button>

      <a
        href={b.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpen(b.url);
        }}
        title={title}
        className="focus-ring flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center"
      >
        <span className="cat-tile-favicon" aria-hidden>
          {faviconFailed ? (
            <span className="flex h-full w-full items-center justify-center text-sm font-semibold uppercase text-brand-ink">
              {host.charAt(0)}
            </span>
          ) : (
            <img
              src={faviconSrc}
              alt=""
              width={24}
              height={24}
              className="h-6 w-6 object-contain"
              loading="lazy"
              onError={() => setFaviconFailed(true)}
            />
          )}
        </span>
        <span className="line-clamp-2 text-xs font-medium leading-snug text-ink">{title}</span>
        <span className="text-2xs tabular-nums text-ink-muted">{b.visitCount ?? 0} 次访问</span>
      </a>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Recently-added strip
 * ------------------------------------------------------------------ */

function RecentAdditions({ bookmarks }: { bookmarks: Bookmark[] }) {
  const recordVisit = useRecordVisit();
  const items = useMemo(
    () =>
      [...bookmarks]
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
        .slice(0, QUICK_LIMIT),
    [bookmarks],
  );

  return (
    <section className="cat-section p-3">
      <div className="mb-2.5 flex items-center gap-1.5 px-1">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-soft text-brand-accent">
          <Clock size={13} aria-hidden />
        </span>
        <h2 className="font-display text-panel font-semibold tracking-tight text-ink">最近添加</h2>
      </div>
      {items.length === 0 ? (
        <p className="px-1 text-xs leading-relaxed text-ink-muted">还没有添加书签。</p>
      ) : (
        <div className="cat-recent-grid">
          {items.map((b) => (
            <RecentRow
              key={b.id}
              bookmark={b}
              onOpen={() => {
                recordVisit.mutate(b.id);
                window.open(b.url, '_blank', 'noopener,noreferrer');
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Dense single-row cell for the recently-added grid (fills the width). */
function RecentRow({ bookmark: b, onOpen }: { bookmark: Bookmark; onOpen: () => void }) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const title = b.title || displayHost(b.url);
  const host = displayHost(b.url);
  const faviconSrc = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;

  return (
    <a
      href={b.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onOpen();
      }}
      title={title}
      className="cat-recent-row focus-ring group"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-sunken" aria-hidden>
        {faviconFailed ? (
          <span className="flex h-full w-full items-center justify-center text-xs font-semibold uppercase text-brand-ink">
            {host.charAt(0)}
          </span>
        ) : (
          <img
            src={faviconSrc}
            alt=""
            width={18}
            height={18}
            className="h-4.5 w-4.5 object-contain"
            loading="lazy"
            onError={() => setFaviconFailed(true)}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-ink group-hover:text-brand-ink">
          {title}
        </span>
        <span className="block truncate text-2xs text-ink-muted">{host}</span>
      </span>
      <ChevronRight
        size={13}
        className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      />
    </a>
  );
}

/* ------------------------------------------------------------------ *
 * Instant in-category search
 * ------------------------------------------------------------------ */

function CategoryInternalSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="cat-search">
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
        aria-hidden
      />
      <label htmlFor="category-internal-search" className="sr-only">
        在当前分类内搜索
      </label>
      {/* eslint-disable-next-line tagnest/require-focus-ring -- .cat-search input:focus 已提供焦点环（border-brand + 3px box-shadow），见 CategoryView.css:253 */}
      <input
        id="category-internal-search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="在当前分类内搜索"
      />
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
      className={cx('cat-tab focus-ring', active ? 'cat-tab-active' : 'cat-tab-inactive')}
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
    <div className="cat-section p-3">
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-caution-soft text-caution">
          <Flame size={13} aria-hidden />
        </span>
        <h3 className="font-display text-panel font-semibold tracking-tight text-ink">全网热搜榜</h3>
      </div>
      {items.length === 0 ? (
        <p className="px-1 text-xs leading-relaxed text-ink-muted">
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
                className="cat-rank-item focus-ring group"
                title={b.title || displayHost(b.url)}
              >
                <span
                  className={cx(
                    'cat-rank-medal',
                    i === 0
                      ? 'bg-critical text-on-brand'
                      : i < 3
                        ? 'bg-brand-soft text-brand-ink'
                        : 'bg-sunken text-ink-muted',
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-soft group-hover:text-ink">
                  {b.title || displayHost(b.url)}
                </span>
                {i === 0 && (
                  <span className="shrink-0 rounded-xs bg-critical-soft px-1 text-2xs font-medium text-critical-ink">
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
    <div className="flex flex-col gap-3">
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
    <section className="cat-block" style={tagColorVars(group.colorIndex)}>
      <button type="button" onClick={onOpen} className="cat-block-header focus-ring group w-full text-left">
        <span className="cat-block-accent" aria-hidden />
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface text-sm shadow-xs"
          aria-hidden
        >
          {categoryEmoji(group.name)}
        </span>
        <h2 className="font-display text-panel font-semibold tracking-tight text-ink">{group.name}</h2>
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium tabular-nums"
          style={{ background: 'var(--tag-bg)', color: 'var(--tag-fg)' }}
        >
          {items.length} 个书签
        </span>
        <ChevronRight
          size={14}
          className="ml-auto shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </button>
      <div className="p-3">
        <SiteGrid items={items} />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Single category tab — sub-sections + child filter + instant search
 * ------------------------------------------------------------------ */

function CategoryDetail({
  group,
  childFilter,
  searchQuery,
  onClearFilter,
  onOrganize,
}: {
  group: CategoryGroup;
  childFilter: string | null;
  searchQuery: string;
  onClearFilter: () => void;
  onOrganize: () => void;
}) {
  const isUntagged = group.id === UNTAGGED_GROUP_ID;
  const children = childFilter ? group.children.filter((c) => c.id === childFilter) : group.children;
  const needle = searchQuery.trim().toLowerCase();

  const matchedChildren = children.map((child) => ({
    ...child,
    items: filterItems(child.items, needle),
  }));
  const matchedDirect = filterItems(group.directItems, needle);
  const hasResults =
    matchedChildren.some((c) => c.items.length > 0) || matchedDirect.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {childFilter && (
        <button
          type="button"
          onClick={onClearFilter}
          className="focus-ring inline-flex w-fit items-center gap-1 rounded-full border border-line px-2.5 py-1 text-2xs text-ink-soft transition-colors hover:text-ink"
        >
          <ChevronRight size={12} className="rotate-180" aria-hidden />
          返回「{group.name}」全部
        </button>
      )}

      {needle && !hasResults && (
        <p className="text-xs text-ink-muted">没有匹配「{searchQuery}」的书签，换个关键词试试。</p>
      )}

      {matchedChildren.map((child) => (
        <SubSection key={child.id} title={child.name} colorIndex={child.colorIndex} items={child.items} />
      ))}

      {matchedDirect.length > 0 && (
        <SubSection title={isUntagged ? '尚未分类' : '常用站点'} items={matchedDirect} untagged={isUntagged} />
      )}

      {isUntagged && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line bg-sunken-wash px-4 py-3">
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
      <div className="mb-2 flex items-center gap-2">
        {!untagged && colorIndex !== undefined && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ ...tagColorVars(colorIndex), background: 'var(--tag-dot)' }}
            aria-hidden
          />
        )}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{title}</h3>
        <span className="text-2xs tabular-nums text-ink-muted">{items.length}</span>
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

  if (items.length === 0) return <p className="text-xs text-ink-muted">该分类下暂无书签。</p>;

  return (
    <div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {visible.map((b) => (
          <li key={b.id}>
            <NavigationTile bookmark={b} />
          </li>
        ))}
      </ul>

      {hasMore && (
        <div className="mt-2.5 flex justify-center">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="focus-ring inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-2xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
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
    <section className="cat-block">
      <div className="cat-block-header">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface text-brand-accent shadow-xs">
          <Sparkles size={14} aria-hidden />
        </span>
        <h2 className="font-display text-panel font-semibold tracking-tight text-ink">{group.name}</h2>
        <span className="inline-flex items-center rounded-full bg-brand-soft px-2 py-0.5 text-2xs font-medium tabular-nums text-brand-ink">
          {items.length} 个书签
        </span>
      </div>
      <div className="p-3">
        <SiteGrid items={items} />
        <div className="mt-2.5 flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line bg-sunken-wash px-4 py-3">
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

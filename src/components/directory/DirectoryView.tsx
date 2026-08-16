import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Compass, ExternalLink, Sparkles } from 'lucide-react';
import type { DirectoryChildGroup, DirectoryGroup, PublicBookmark } from '@shared/types';
import { displayHost, faviconFor } from '@/lib/url';
import { cx } from '@/lib/cx';
import { Reveal } from '@/components/atelier';
import { tagColorVars } from '@/components/ui';

/**
 * Default cap on cards shown per sub-category in the directory view. Visitors
 * can expand a section past this — the cap exists only so a category with 80
 * bookmarks does not blow up the first paint.
 */
const PER_SECTION_LIMIT = 8;
const UNTAGGED_ID = '__untagged';

/**
 * Two-level category browser — public-facing navigation-site layout.
 *
 * The directory theme (`ShareTheme = 'directory'`) renders this component in
 * SharePage. It is the same shape visitors expect from sites like hao123:
 * a sticky left sidebar lists the first-level categories; the main area
 * shows a 2- to 4-column card grid per sub-category; each section can be
 * collapsed/expanded independently; mobile collapses the sidebar into a
 * horizontally-scrolling chip strip pinned to the top.
 *
 * Source data is the pre-aggregated `DirectoryGroup[]` produced by the
 * backend. This component never re-derives the grouping — it only renders
 * what the server gave it, so the page is cheap to hydrate.
 */
export function DirectoryView({
  groups,
  storageKey,
}: {
  groups: DirectoryGroup[];
  /**
   * LocalStorage key to persist which sections a visitor collapsed. Different
   * share slugs get different keys so collapsing a section on share A doesn't
   * bleed into share B.
   */
  storageKey: string;
}) {
  // Collapse state per section, restored from localStorage so a returning
  // visitor sees the same layout they left.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });

  // Track the section currently in view on mobile so the chip strip can
  // auto-scroll to keep the active chip visible. Uses scrollIntoView with
  // 'nearest' so it only moves when strictly needed.
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const chipStripRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | undefined>(() => groups[0]?.id);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(collapsed));
    } catch {
      /* quota / private mode — ignore */
    }
  }, [collapsed, storageKey]);

  // Observe sections coming into view to drive the active-chip highlight.
  useEffect(() => {
    if (typeof window === 'undefined' || groups.length === 0) return;

    const map = sectionRefs.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('data-section-id');
            if (id) setActiveId(id);
          }
        }
      },
      { rootMargin: '-30% 0px -55% 0px', threshold: 0 },
    );

    for (const el of map.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [groups]);

  if (groups.length === 0) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <Compass size={28} className="mx-auto mb-3 text-ink-faint" aria-hidden />
        <p className="atelier-display atelier-display--3 text-ink">还没有可浏览的分类</p>
        <p className="mt-2 text-sm text-ink-soft">
          当书签被打上分类标签后，它们会按一级、二级分类整理在这里。
        </p>
      </div>
    );
  }

  const totalBookmarks = groups.reduce(
    (sum, g) => sum + g.directItems.length + g.children.reduce((s, c) => s + c.items.length, 0),
    0,
  );

  const toggle = (id: string) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  const jumpTo = (id: string) => {
    const el = sectionRefs.current.get(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      {/* Sticky, scroll-spy-aware sidebar of first-level categories. */}
      <aside className="hidden lg:block">
        <div className="sticky top-4 rounded-xl border border-line bg-surface/80 p-2.5 backdrop-blur-md">
          <p className="atelier-index mb-2 px-2 pt-1">分类 · CATEGORIES</p>
          <ul className="flex flex-col gap-0.5">
            {groups.map((g) => {
              const count =
                g.directItems.length + g.children.reduce((s, c) => s + c.items.length, 0);
              const isActive = activeId === g.id;
              const isUntagged = g.id === UNTAGGED_ID;
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => jumpTo(g.id)}
                    className={cx(
                      'nav-row group w-full',
                      isActive && 'is-active',
                      isUntagged && 'text-ink-faint',
                    )}
                  >
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={
                        isUntagged
                          ? undefined
                          : { ...tagColorVars(g.colorIndex), background: 'var(--tag-dot)' }
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-left">{g.name}</span>
                    <span className="shrink-0 text-2xs tabular-nums text-ink-faint">{count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      {/* Mobile chip strip — horizontal scroller fixed under the header. */}
      <div className="lg:hidden">
        <div
          ref={chipStripRef}
          className="scrollbar-slim sticky top-2 z-10 -mx-4 flex gap-1.5 overflow-x-auto px-4 py-1.5"
          role="tablist"
          aria-label="分类导航"
        >
          {groups.map((g) => {
            const isActive = activeId === g.id;
            const isUntagged = g.id === UNTAGGED_ID;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => jumpTo(g.id)}
                role="tab"
                aria-selected={isActive}
                className={cx(
                  'shrink-0 rounded-full border px-3 py-1 text-xs transition-colors',
                  isActive
                    ? 'border-brand-accent bg-brand-soft text-brand-ink'
                    : isUntagged
                      ? 'border-line text-ink-faint'
                      : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
                )}
              >
                {g.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main area — one first-level section per group, with its sub-categories
          inlined. */}
      <div className="flex min-w-0 flex-col gap-6">
        <Reveal as="div" className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="atelier-eyebrow !text-ink-soft">
            <Compass size={13} aria-hidden />
            全部分类
          </p>
          <p className="text-2xs text-ink-faint tabular-nums">
            {groups.length} 个一级分类 · {totalBookmarks} 个书签
          </p>
        </Reveal>

        <div className="flex flex-col gap-12">
          {groups.map((group, groupIdx) => {
            const isUntagged = group.id === UNTAGGED_ID;
            const isCollapsed = collapsed[group.id] === true;
            const childCount = group.children.length;
            const directCount = group.directItems.length;
            const totalCount = directCount + group.children.reduce((s, c) => s + c.items.length, 0);

            return (
              <section
                key={group.id}
                data-section-id={group.id}
                ref={(el) => {
                  if (el) sectionRefs.current.set(group.id, el);
                  else sectionRefs.current.delete(group.id);
                }}
                className="scroll-mt-20"
                aria-labelledby={`section-${group.id}`}
              >
                <Reveal delay={Math.min(groupIdx, 5) * 60}>
                  <div className="mb-4 flex items-end justify-between gap-3 border-b border-line pb-2">
                    <div className="flex min-w-0 items-baseline gap-3">
                      <h2
                        id={`section-${group.id}`}
                        className="atelier-display atelier-display--3 flex items-center gap-2 text-ink"
                      >
                        {!isUntagged && (
                          <span
                            aria-hidden
                            className="inline-block h-3 w-3 shrink-0 rounded-sm"
                            style={{ ...tagColorVars(group.colorIndex), background: 'var(--tag-dot)' }}
                          />
                        )}
                        {isUntagged && (
                          <Sparkles size={16} aria-hidden className="text-ink-faint" />
                        )}
                        {group.name}
                      </h2>
                      <span className="text-xs tabular-nums text-ink-faint">
                        {childCount > 0 && `${childCount} 个子类 · `}
                        {totalCount} 个书签
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggle(group.id)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-2xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                      aria-expanded={!isCollapsed}
                    >
                      {isCollapsed ? (
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
                </Reveal>

                  {!isCollapsed && (
                    <div className="flex flex-col gap-7">
                      {directCount > 0 && (
                        <DirectoryRow
                          title={isUntagged ? '尚未打标签' : '直接归类'}
                          items={group.directItems}
                          untagged={isUntagged}
                        />
                      )}

                      {group.children.map((child) => (
                        <DirectoryRow
                          key={child.id}
                          title={child.name}
                          colorIndex={child.colorIndex}
                          items={child.items}
                        />
                      ))}

                      {isUntagged && (
                        <p className="rounded-md border border-dashed border-line bg-sunken/60 px-4 py-3 text-xs leading-relaxed text-ink-soft">
                          这些书签还没有分类标签。在 TagNest 内选中它们并打上标签，下次分享时它们就会自动归入对应分组。
                        </p>
                      )}
                    </div>
                  )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * A single sub-section: a small title bar + 2/3/4-column responsive card grid
 * with a 'load more' expand control when items exceed the cap.
 */
function DirectoryRow({
  title,
  colorIndex,
  items,
  untagged,
}: {
  title: string;
  colorIndex?: number;
  items: PublicBookmark[];
  /** When true the row shows the no-tag hint instead of the colored dot. */
  untagged?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = items.length > PER_SECTION_LIMIT;

  // Stable ordering: newer first, then alphabetical. Memoised so unrelated
  // re-renders (state toggles, theme changes) don't re-sort.
  const ordered = useMemo(
    () =>
      items
        .slice()
        .sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title, 'zh-CN'),
        ),
    [items],
  );
  const visibleOrdered = expanded ? ordered : ordered.slice(0, PER_SECTION_LIMIT);

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

      <Reveal as="ul" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visibleOrdered.map((b) => (
          <li key={b.id}>
            <DirectoryCard bookmark={b} />
          </li>
        ))}
      </Reveal>

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

function DirectoryCard({ bookmark: b }: { bookmark: PublicBookmark }) {
  return (
    <a
      href={b.url}
      target="_blank"
      rel="noopener noreferrer"
      className="spotlight group flex h-full items-start gap-2.5 rounded-xl border border-line bg-surface/85 p-3 backdrop-blur-sm transition-all hover:border-line-strong hover:shadow-raised focus-visible:border-brand-accent focus-visible:outline-none"
    >
      <img
        src={faviconFor(b.url, 32)}
        alt=""
        width={22}
        height={22}
        loading="lazy"
        decoding="async"
        className="mt-0.5 h-[22px] w-[22px] shrink-0 rounded-sm bg-sunken object-contain"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <h4 className="min-w-0 truncate text-2xs font-semibold text-ink group-hover:text-brand-ink">
            {b.title || displayHost(b.url)}
          </h4>
          <ExternalLink
            size={11}
            className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
        </div>
        {b.description || b.note ? (
          <p className="mt-1 line-clamp-1 text-[11px] leading-snug text-ink-soft">
            {b.description || b.note}
          </p>
        ) : null}
        <p className="mt-0.5 truncate text-[11px] tabular-nums text-ink-faint">
          {displayHost(b.url)}
        </p>
      </div>
    </a>
  );
}

export type { DirectoryChildGroup, DirectoryGroup };

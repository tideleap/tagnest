import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Archive,
  ChevronsLeft,
  ChevronsRight,
  Download,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  Layers,
  Settings,
  Star,
  Tag as TagIcon,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/cx';
import { IconButton, Skeleton, TagChip } from '@/components/ui';
import { useOverlay, useView } from '@/stores/ui';
import { useStats, useTags } from '@/hooks/queries';

/**
 * How labels behave at the current width.
 *
 * `lg` is the interesting one: between md and lg the sidebar is a 56px icon
 * rail, and only past lg is there room for text. Expressing that in CSS rather
 * than a JS boolean means no layout thrash and no resize listener.
 */
type LabelMode = 'always' | 'never' | 'lg';

const ROW_LAYOUT: Record<LabelMode, string> = {
  always: 'px-2.5',
  never: 'w-9 justify-center',
  lg: 'w-9 justify-center lg:w-auto lg:justify-start lg:px-2.5',
};

const LABEL_VISIBILITY: Record<LabelMode, string> = {
  always: 'flex',
  never: 'hidden',
  lg: 'hidden lg:flex',
};

const BLOCK_VISIBILITY: Record<LabelMode, string> = {
  always: 'block',
  never: 'hidden',
  lg: 'hidden lg:block',
};

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  countKey?: 'bookmarks' | 'favorites' | 'archived' | 'trashed' | 'inbox';
}

const PRIMARY: NavItem[] = [
  { to: '/dashboard', label: '概览', icon: LayoutDashboard },
  { to: '/library/inbox', label: '收件箱', icon: Inbox, countKey: 'inbox' },
  { to: '/library/all', label: '全部书签', icon: Layers, countKey: 'bookmarks' },
  { to: '/library/favorites', label: '收藏', icon: Star, countKey: 'favorites' },
  { to: '/library/archive', label: '归档', icon: Archive, countKey: 'archived' },
];

const SECONDARY: NavItem[] = [
  { to: '/tags', label: '标签', icon: TagIcon },
  { to: '/tab-groups', label: '标签页组', icon: FolderOpen },
  { to: '/import', label: '导入导出', icon: Download },
  { to: '/library/trash', label: '回收站', icon: Trash2, countKey: 'trashed' },
  { to: '/settings', label: '设置', icon: Settings },
];

function NavRow({
  item,
  count,
  mode,
  onNavigate,
}: {
  item: NavItem;
  count?: number;
  mode: LabelMode;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;

  return (
    <NavLink
      to={item.to}
      end={item.to === '/tags'}
      onClick={onNavigate}
      title={item.label}
      className={({ isActive }) =>
        cx(
          'flex h-9 items-center gap-2.5 rounded-md text-sm font-medium transition-colors',
          ROW_LAYOUT[mode],
          isActive
            ? 'bg-brand-soft text-brand-ink'
            : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
        )
      }
    >
      <Icon size={17} className="shrink-0" aria-hidden />
      <span className={cx('min-w-0 flex-1 items-center truncate', LABEL_VISIBILITY[mode])}>
        {item.label}
      </span>
      {count !== undefined && count > 0 && (
        <span
          className={cx(
            'shrink-0 items-center text-2xs tabular-nums text-ink-faint',
            LABEL_VISIBILITY[mode],
          )}
        >
          {count > 999 ? '999+' : count}
        </span>
      )}
    </NavLink>
  );
}

function SidebarContent({ mode, onNavigate }: { mode: LabelMode; onNavigate?: () => void }) {
  const { data: stats } = useStats();
  const { data: tags, isLoading: tagsLoading } = useTags();

  const counts: Record<string, number | undefined> = {
    inbox: stats?.untagged,
    bookmarks: stats?.bookmarks,
    favorites: stats?.favorites,
    archived: stats?.archived,
    trashed: stats?.trashed,
  };

  // Only the busiest tags earn a slot; the rest live on the tags page.
  const topTags = (tags ?? []).filter((t) => t.count > 0).slice(0, 8);

  return (
    <nav aria-label="书签分区" className="flex h-full flex-col px-2 py-3">
      <ul className="flex flex-col gap-0.5">
        {PRIMARY.map((item) => (
          <li key={item.to}>
            <NavRow
              item={item}
              count={item.countKey ? counts[item.countKey] : undefined}
              mode={mode}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>

      <div className={cx('mt-4 min-h-0 flex-1 overflow-y-auto scrollbar-slim', BLOCK_VISIBILITY[mode])}>
        <h2 className="px-2.5 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          常用标签
        </h2>
        {tagsLoading ? (
          <div className="flex flex-col gap-1.5 px-2.5 py-1">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-20" />
          </div>
        ) : topTags.length === 0 ? (
          <p className="px-2.5 text-xs leading-relaxed text-ink-faint">
            还没有标签。给书签打上标签后会出现在这里。
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5 px-2.5">
            {topTags.map((tag) => (
              <li key={tag.id}>
                <NavLink to={`/tags/${tag.id}`} onClick={onNavigate}>
                  {({ isActive }) => (
                    <TagChip
                      name={tag.name}
                      colorIndex={tag.colorIndex}
                      count={tag.count}
                      size="sm"
                      active={isActive}
                    />
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ul className="mt-3 flex flex-col gap-0.5 border-t border-line pt-2">
        {SECONDARY.map((item) => (
          <li key={item.to}>
            <NavRow
              item={item}
              count={item.countKey ? counts[item.countKey] : undefined}
              mode={mode}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function BrandMark({ mode }: { mode: LabelMode }) {
  return (
    <span className="flex items-center gap-2 overflow-hidden">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand text-on-brand">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M7 4h10a1 1 0 0 1 1 1v14.4a.7.7 0 0 1-1.1.57L12 16.6l-4.9 3.37A.7.7 0 0 1 6 19.4V5a1 1 0 0 1 1-1Z"
            fill="currentColor"
          />
        </svg>
      </span>
      <span
        className={cx(
          'truncate text-base font-semibold tracking-tight text-ink',
          BLOCK_VISIBILITY[mode],
        )}
      >
        TagNest
      </span>
    </span>
  );
}

export function Sidebar() {
  const collapsed = useView((s) => s.sidebarCollapsed);
  const toggle = useView((s) => s.toggleSidebar);
  const mobileOpen = useOverlay((s) => s.mobileNavOpen);
  const setMobileOpen = useOverlay((s) => s.setMobileNavOpen);
  const location = useLocation();

  // A drawer that survives navigation covers the page it just opened.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, setMobileOpen]);

  const desktopMode: LabelMode = collapsed ? 'never' : 'lg';

  return (
    <>
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-30 hidden shrink-0 flex-col border-r border-line bg-surface md:flex',
          'transition-[width] duration-200',
          collapsed ? 'w-14' : 'w-14 lg:w-60',
        )}
      >
        <div className="flex h-14 shrink-0 items-center border-b border-line px-3">
          <BrandMark mode={desktopMode} />
        </div>

        <div className="min-h-0 flex-1">
          <SidebarContent mode={desktopMode} />
        </div>

        <div className="hidden shrink-0 border-t border-line p-2 lg:block">
          <IconButton
            label={collapsed ? '展开侧栏' : '收起侧栏'}
            icon={collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            onClick={toggle}
            size="sm"
          />
        </div>
      </aside>

      {/* Below md the sidebar becomes an off-canvas drawer. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="anim-fade absolute inset-0 bg-black/35"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside
            className="anim-rise absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col bg-surface shadow-modal"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-3">
              <BrandMark mode="always" />
              <IconButton
                label="关闭导航"
                icon={<X size={17} />}
                onClick={() => setMobileOpen(false)}
              />
            </div>
            <div className="min-h-0 flex-1">
              <SidebarContent mode="always" onNavigate={() => setMobileOpen(false)} />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

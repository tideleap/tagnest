import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Archive,
  BarChart3,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Folder,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  Layers,
  Lock,
  Settings,
  Sparkles,
  Star,
  Tag as TagIcon,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Tag } from '@shared/types';
import { buildTagTree, subtreeIds, type TreeNode } from '@/components/tags/buildTagTree';
import { cx } from '@/lib/cx';
import { IconButton, Skeleton } from '@/components/ui';
import { useOverlay, useView } from '@/stores/ui';
import { useStats, useTags } from '@/hooks/queries';
import { useVault } from '@/stores/vault';
import { Logo } from '@/components/decor/Logo';

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
  /** Renders the vault's lock state instead of a count. */
  vaultState?: boolean;
}

const PRIMARY: NavItem[] = [
  { to: '/dashboard', label: '概览', icon: LayoutDashboard },
  { to: '/library/inbox', label: '收件箱', icon: Inbox, countKey: 'inbox' },
  { to: '/library/all', label: '全部书签', icon: Layers, countKey: 'bookmarks' },
  { to: '/library/favorites', label: '收藏', icon: Star, countKey: 'favorites' },
  { to: '/library/archive', label: '归档', icon: Archive, countKey: 'archived' },
];

const SECONDARY: NavItem[] = [
  // Sits directly above 标签: organising and the vocabulary it produces are
  // the same job, and the entry point has to be visible for a feature that
  // used to be an invisible side-effect of saving.
  { to: '/organize', label: 'AI 整理', icon: Sparkles },
  { to: '/tags', label: '标签', icon: TagIcon },
  { to: '/tab-groups', label: '标签页组', icon: FolderOpen },
  { to: '/collections', label: '集合', icon: Folder },
  { to: '/timeline', label: '时间线', icon: CalendarClock },
  { to: '/report', label: '报告', icon: BarChart3 },
  { to: '/import', label: '导入导出', icon: Download },
  // Deliberately has no count: the number of private bookmarks is itself
  // information the vault is supposed to withhold from a shoulder-surfer.
  { to: '/private', label: '私密保险库', icon: Lock, vaultState: true },
  { to: '/library/trash', label: '回收站', icon: Trash2, countKey: 'trashed' },
  { to: '/settings', label: '设置', icon: Settings },
];

function NavRow({
  item,
  count,
  trailing,
  mode,
  onNavigate,
}: {
  item: NavItem;
  count?: number;
  trailing?: ReactNode;
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
          'group relative flex h-9 items-center gap-2.5 rounded-md text-sm font-medium transition-colors duration-150',
          ROW_LAYOUT[mode],
          isActive
            ? 'bg-brand-soft text-brand-ink'
            : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Active indicator — a warm accent bar hugging the left edge, echoing
              the homepage's brand-accent stamp. Fades in softly, appears faintly
              on hover so the affordance is discoverable before activation. */}
          <span
            aria-hidden
            className={cx(
              'absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-brand-accent transition-all duration-150',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40',
            )}
          />
          <Icon
            size={17}
            className="shrink-0 transition-transform duration-150 group-hover:scale-110"
            aria-hidden
          />
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
          {trailing && (
            <span className={cx('shrink-0 items-center', LABEL_VISIBILITY[mode])}>{trailing}</span>
          )}
        </>
      )}
    </NavLink>
  );
}

function SidebarContent({ mode, onNavigate }: { mode: LabelMode; onNavigate?: () => void }) {
  const { data: stats } = useStats();
  const { data: tags, isLoading: tagsLoading } = useTags();

  // Resolving the vault's configured/locked state here (rather than only on the
  // vault page) is what lets the nav row warn that the vault is currently open.
  const vaultStatus = useVault((s) => s.status);
  const bootstrapVault = useVault((s) => s.bootstrap);
  useEffect(() => {
    void bootstrapVault();
  }, [bootstrapVault]);

  const counts: Record<string, number | undefined> = {
    inbox: stats?.untagged,
    bookmarks: stats?.bookmarks,
    favorites: stats?.favorites,
    archived: stats?.archived,
    trashed: stats?.trashed,
  };

  const navigate = useNavigate();
  const [params] = useSearchParams();
  const activeTagIds = useMemo(
    () =>
      (params.get('tagIds') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [params],
  );

  // Clicking a tag toggles its whole subtree in/out of the multi-tag
  // `?tagIds=` filter (OR semantics), staying in the library. Clicking a parent
  // therefore browses every bookmark under it, not just those tagged directly.
  const toggleTag = (id: string) => {
    const sub = subtreeIds(tags ?? [], id);
    const allActive = sub.every((sid) => activeTagIds.includes(sid));
    const nextTagIds = allActive
      ? activeTagIds.filter((t) => !sub.includes(t))
      : Array.from(new Set([...activeTagIds, ...sub]));

    const next = new URLSearchParams(params);
    if (nextTagIds.length > 0) next.set('tagIds', nextTagIds.join(','));
    else next.delete('tagIds');
    navigate(`/library/all?${next.toString()}`, { replace: true });
    onNavigate?.();
  };

  return (
    <nav aria-label="书签分区" className="flex h-full flex-col px-2 py-3">
      <ul className="flex flex-col gap-1">
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

      <div className={cx('mt-5 min-h-0 flex-1 overflow-y-auto scrollbar-slim', BLOCK_VISIBILITY[mode])}>
        <h2 className="px-2.5 pb-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          标签分组
        </h2>
        {tagsLoading ? (
          <div className="flex flex-col gap-1.5 px-2.5 py-1">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-20" />
          </div>
        ) : (tags ?? []).length === 0 ? (
          <p className="px-2.5 text-xs leading-relaxed text-ink-faint">
            还没有标签。给书签打上标签后会出现在这里。
          </p>
        ) : (
          <TagTree tags={tags ??[]} activeTagIds={activeTagIds} onToggle={toggleTag} />
        )}
      </div>

      <ul className="mt-4 flex flex-col gap-1 border-t border-line pt-3">
        {SECONDARY.map((item) => (
          <li key={item.to}>
            <NavRow
              item={item}
              count={item.countKey ? counts[item.countKey] : undefined}
              trailing={
                item.vaultState && vaultStatus === 'unlocked' ? (
                  <span
                    title="保险库已解锁"
                    aria-label="保险库已解锁"
                    className="block h-1.5 w-1.5 rounded-full bg-brand-accent"
                  />
                ) : undefined
              }
              mode={mode}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function TagTree({
  tags,
  activeTagIds,
  onToggle,
}: {
  tags: Tag[];
  activeTagIds: string[];
  onToggle: (id: string) => void;
}) {
  const tree = useMemo(() => buildTagTree(tags), [tags]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // The tags query resolves after the first render, so a useState initializer
  // would seed the expansion from an empty tree and never run again. Seed it
  // exactly once, the first time the tree actually has content.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || tree.length === 0) return;
    seeded.current = true;
    setExpanded(new Set(tree.slice(0, 5).map((t) => t.id)));
  }, [tree]);

  if (tree.length === 0) {
    return (
      <p className="px-2.5 text-xs leading-relaxed text-ink-faint">
        还没有可归类的标签。
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 px-1.5">
      {tree.map((top) => (
        <TreeNodeRow
          key={top.id}
          node={top}
          depth={0}
          expanded={expanded}
          onToggleExpand={(id) =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          activeTagIds={activeTagIds}
          onToggleTag={onToggle}
        />
      ))}
    </ul>
  );
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  onToggleExpand,
  activeTagIds,
  onToggleTag,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  activeTagIds: string[];
  onToggleTag: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const active = activeTagIds.includes(node.id);
  const indent = depth * 12;

  return (
    <li className="flex flex-col">
      <div
        className={cx(
          'group flex w-full items-center gap-1 rounded-md py-1 pr-1.5 text-left text-2xs transition-colors',
          active
            ? 'bg-brand-soft text-brand-ink'
            : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.id)}
            className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-hover hover:text-ink"
            aria-label={isOpen ? '收起' : '展开'}
          >
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-5" />
        )}
        <button
          type="button"
          onClick={() => onToggleTag(node.id)}
          className={cx(
            'min-w-0 flex-1 truncate text-left',
            active ? 'text-brand-ink' : 'text-ink-soft group-hover:text-ink',
          )}
        >
          {node.name}
        </button>
        <button
          type="button"
          onClick={() => onToggleTag(node.id)}
          className={cx(
            'shrink-0 tabular-nums',
            active ? 'text-brand-ink' : 'text-ink-faint group-hover:text-ink-soft',
          )}
        >
          {node.count}
        </button>
      </div>
      {hasChildren && isOpen && (
        <ul className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              activeTagIds={activeTagIds}
              onToggleTag={onToggleTag}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function BrandMark({ mode }: { mode: LabelMode }) {
  // Collapsed icon-rail keeps a compact 32px tile (the 56px rail must fit
  // tile + padding); expanded lets the mark breathe large as the visual anchor.
  const size = mode === 'lg' ? 44 : 32;
  return (
    <span className="flex items-center gap-2.5 overflow-hidden">
      <span className="logo-breathe grow-0">
        <Logo size={size} />
      </span>
      <span
        className={cx(
          'truncate text-lg font-semibold tracking-tight text-ink',
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
          'glass fixed inset-y-0 left-0 z-30 hidden flex-col md:flex',
          'm-3 mb-3 rounded-2xl shadow-float',
          'transition-[width] duration-200',
          collapsed ? 'w-14' : 'w-14 lg:w-60',
        )}
      >
        <div className="flex h-14 shrink-0 items-center px-3">
          <BrandMark mode={desktopMode} />
        </div>

        <div className="min-h-0 flex-1 pb-1">
          <SidebarContent mode={desktopMode} />
        </div>

        <div className="hidden shrink-0 p-2 pt-1 lg:block">
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
            className="anim-fade absolute inset-0 bg-black/35 backdrop-blur-[1px]"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="anim-rise absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col bg-surface shadow-modal">
            <div className="flex h-14 shrink-0 items-center justify-between px-3">
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

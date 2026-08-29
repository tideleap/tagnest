import { NavLink } from 'react-router-dom';
import { Inbox, Layers, Plus, Star, Tag as TagIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/cx';
import { useOverlay } from '@/stores/ui';

const TABS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/library/inbox', label: '收件箱', icon: Inbox },
  { to: '/library/all', label: '全部', icon: Layers },
  { to: '/library/favorites', label: '收藏', icon: Star },
  { to: '/tags', label: '标签', icon: TagIcon },
];

/**
 * Phone-only bottom navigation.
 *
 * The add button sits in the middle because that is where a thumb naturally
 * rests, and adding is the action people repeat most.
 *
 * Rendering notes (scroll artifacts on phones):
 *  - Solid bg-surface/95 instead of .glass: backdrop-filter forces the
 *    compositor to resample the scrolling background every frame, which
 *    smears/flickers the icons on mobile Chrome and Safari mid-scroll.
 *  - min-h-14 instead of h-14: the iPhone home-indicator safe area is added
 *    INSIDE the bar by pad-safe-b, and a fixed height would crush the
 *    icon+label stack on devices with a 34px inset.
 *  - transform-gpu: own compositor layer so the bar never repaints together
 *    with the scrolling page (no tearing while fling-scrolling).
 */
export function MobileTabBar() {
  const setQuickAddOpen = useOverlay((s) => s.setQuickAddOpen);

  return (
    <nav
      aria-label="快捷导航"
      className="pad-safe-b fixed inset-x-3 bottom-3 z-30 flex min-h-14 items-stretch rounded-2xl bg-surface/95 shadow-float transform-gpu md:hidden"
    >
      {TABS.slice(0, 2).map((tab) => (
        <TabLink key={tab.to} {...tab} />
      ))}

      <div className="flex shrink-0 items-center justify-center px-1">
        <button
          type="button"
          onClick={() => setQuickAddOpen(true)}
          aria-label="添加书签"
          className="brand-grad flex h-11 w-11 items-center justify-center rounded-full text-on-brand shadow-glow transition-transform active:scale-95"
        >
          <Plus size={21} />
        </button>
      </div>

      {TABS.slice(2).map((tab) => (
        <TabLink key={tab.to} {...tab} />
      ))}
    </nav>
  );
}

function TabLink({ to, label, icon: Icon }: { to: string; label: string; icon: LucideIcon }) {
  return (
    <NavLink
      to={to}
      end={to === '/tags'}
      className={({ isActive }) =>
        cx(
          'flex flex-1 flex-col items-center justify-center gap-0.5 text-2xs font-medium transition-colors',
          isActive ? 'text-brand-ink' : 'text-ink-faint',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={19} strokeWidth={isActive ? 2.3 : 1.9} aria-hidden />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}

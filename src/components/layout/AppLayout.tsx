import { Suspense, lazy } from 'react';
import { Outlet } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { useOverlay, useView } from '@/stores/ui';
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { MobileTabBar } from './MobileTabBar';
import { AmbientGlow } from '@/components/decor/AmbientGlow';
import { cx } from '@/lib/cx';

const CommandPalette = lazy(() =>
  import('@/components/command/CommandPalette').then((m) => ({ default: m.CommandPalette })),
);
const QuickAddDialog = lazy(() =>
  import('@/components/bookmark/QuickAddDialog').then((m) => ({ default: m.QuickAddDialog })),
);
const BookmarkEditor = lazy(() =>
  import('@/components/bookmark/BookmarkEditor').then((m) => ({ default: m.BookmarkEditor })),
);

/**
 * The one shell every signed-in route renders inside.
 *
 * Four real breakpoints rather than a phone/desktop binary:
 *   base   phones          — tab bar at the bottom, sidebar as a drawer
 *   md     tablet portrait — icon rail, labels hidden
 *   lg     laptop          — full sidebar with labels
 *   xl     desktop         — sidebar plus a wider content column
 */
export function AppLayout() {
  const collapsed = useView((s) => s.sidebarCollapsed);
  const { commandOpen, quickAddOpen, editingBookmarkId } = useOverlay();

  useGlobalHotkeys();

  return (
    <div className="relative flex min-h-dvh bg-canvas">
      {/* Static decoration layer — gradient light blobs + a faint dot texture.
          pointer-events-none, low opacity, so it adds warmth and depth without
          ever crowding content or swallowing clicks. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* dotted texture, brand-tinted */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)',
            backgroundSize: '26px 26px',
            color: 'var(--color-brand-ink)',
            opacity: 0.05,
            maskImage: 'radial-gradient(ellipse 60% 60% at 50% 0%, #000 40%, transparent 100%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 60% 60% at 50% 0%, #000 40%, transparent 100%)',
          }}
        />
        {/* warm corner washes */}
        <div className="absolute -left-24 -top-32 h-96 w-96 rounded-full bg-brand-soft/50 blur-[90px]" />
        <div className="absolute right-[-8rem] top-16 h-80 w-80 rounded-full bg-brand-accent/20 blur-[100px]" />
        {/* a low, centred geometric accent to ground the page */}
        <div className="absolute bottom-[-10rem] right-1/4 h-80 w-80 rounded-full border border-brand-soft/40 blur-[2px]" />
      </div>

      {/* Cursor-following ambient light — desktop + smooth pointer only. */}
      <AmbientGlow />

      {/* Skip link — the first stop for keyboard users, invisible until focused. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:shadow-overlay"
      >
        跳到主要内容
      </a>

      <Sidebar />

      <div
        className={cx(
          'anim-page-enter relative flex min-w-0 flex-1 flex-col transition-[padding] duration-200',
          // Reserve room for the floating rail (width + 12px gutter) from md up.
          collapsed ? 'md:pl-[4.25rem]' : 'md:pl-[4.25rem] lg:pl-[15.75rem]',
        )}
      >
        <TopBar />

        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-7xl flex-1 px-3 pb-24 pt-3 outline-none sm:px-5 md:pb-8 md:pt-5 xl:px-8 xl:pt-6"
        >
          <Outlet />
        </main>
      </div>

      <MobileTabBar />

      <Suspense fallback={null}>
        {commandOpen && <CommandPalette />}
        {quickAddOpen && <QuickAddDialog />}
        {editingBookmarkId && <BookmarkEditor id={editingBookmarkId} />}
      </Suspense>
    </div>
  );
}

export function PageLoader() {
  return (
    <div className="flex min-h-64 items-center justify-center text-ink-faint">
      <Spinner size={20} />
    </div>
  );
}

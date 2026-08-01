import { Suspense, lazy } from 'react';
import { Outlet } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { useOverlay, useView } from '@/stores/ui';
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { MobileTabBar } from './MobileTabBar';
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
    <div className="flex min-h-dvh bg-canvas">
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
          'flex min-w-0 flex-1 flex-col transition-[padding] duration-200',
          // Reserve room for the fixed rail from md up.
          collapsed ? 'md:pl-14' : 'md:pl-14 lg:pl-60',
        )}
      >
        <TopBar />

        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-7xl flex-1 px-3 pb-24 pt-3 outline-none sm:px-4 md:pb-6 md:pt-4 xl:px-6"
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

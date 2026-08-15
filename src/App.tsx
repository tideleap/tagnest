import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { useTheme } from '@/stores/ui';
import { Spinner, Toaster } from '@/components/ui';
import { AppLayout } from '@/components/layout/AppLayout';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { LibraryPage } from '@/pages/LibraryPage';

/**
 * Old `/tags/:tagId` deep-link → new `?tagIds=` search filter.
 *
 * The tag-filter view used to live at `/tags/:tagId` (a path param). It now
 * lives at `/library/all?tagIds=` (a search param, so it is multi-tag and can
 * be cleared in place). This redirect preserves any saved/bookmarked old URL by
 * rewriting the path param into the search param before reaching the library.
 */
function OldTagRedirect() {
  const { tagId } = useParams();
  return <Navigate to={`/library/all?tagIds=${encodeURIComponent(tagId ?? '')}`} replace />;
}

// Split off everything that isn't the first screen a signed-in user sees.
const AuthPage = lazy(() => import('@/pages/AuthPage').then((m) => ({ default: m.AuthPage })));
const TagsPage = lazy(() => import('@/pages/TagsPage').then((m) => ({ default: m.TagsPage })));
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const ImportPage = lazy(() =>
  import('@/pages/ImportPage').then((m) => ({ default: m.ImportPage })),
);
const NotFoundPage = lazy(() =>
  import('@/pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
);
const SharePage = lazy(() =>
  import('@/pages/SharePage').then((m) => ({ default: m.SharePage })),
);
const TabGroupsPage = lazy(() =>
  import('@/pages/TabGroupsPage').then((m) => ({ default: m.TabGroupsPage })),
);
const CollectionsPage = lazy(() =>
  import('@/pages/CollectionsPage').then((m) => ({ default: m.CollectionsPage })),
);
const CollectionDetail = lazy(() =>
  import('@/pages/CollectionDetail').then((m) => ({ default: m.CollectionDetail })),
);
const DashboardPage = lazy(() =>
  import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const OrganizePage = lazy(() =>
  import('@/pages/OrganizePage').then((m) => ({ default: m.OrganizePage })),
);
const PrivateVaultPage = lazy(() =>
  import('@/pages/PrivateVaultPage').then((m) => ({ default: m.PrivateVaultPage })),
);
const TimelinePage = lazy(() =>
  import('@/pages/TimelinePage').then((m) => ({ default: m.TimelinePage })),
);

function RouteFallback() {
  return (
    <div className="flex h-full min-h-64 items-center justify-center text-ink-faint">
      <Spinner size={22} />
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-faint">
        <Spinner size={24} />
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}

export function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  const themeMode = useTheme((s) => s.mode);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    // Re-assert on mount in case the inline head script and the store disagree.
    // Runs once: we intentionally want the initial theme, not every future
    // change — per-render updates are handled by setMode's own persistence.
    useTheme.getState().setMode(themeMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once bootstrap
  }, []);

  return (
    <ErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/signin" element={<AuthPage mode="signin" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          {/* Public, unauthenticated share pages. */}
          <Route path="/s/:slug" element={<SharePage />} />

          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/library/:scope" element={<LibraryPage />} />
            <Route path="/organize" element={<OrganizePage />} />
            <Route path="/tags" element={<TagsPage />} />
            {/* Old single-tag filter URL → new multi-tag search param. */}
            <Route path="/tags/:tagId" element={<OldTagRedirect />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/tab-groups" element={<TabGroupsPage />} />
            <Route path="/collections" element={<CollectionsPage />} />
            <Route path="/collections/:id" element={<CollectionDetail />} />
            <Route path="/timeline" element={<TimelinePage />} />
            <Route path="/private" element={<PrivateVaultPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/:section" element={<SettingsPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
      <Toaster />
    </ErrorBoundary>
  );
}

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { DashboardPage } from './DashboardPage';
import { queryClient } from '@/lib/queryClient';

// Atelier motion wrappers rely on IntersectionObserver / pointer tracking that
// happy-dom does not fully implement. They are pure presentation, so render
// their children directly — the navigation behaviour under test is unchanged.
vi.mock('@/components/atelier', () => ({
  KineticText: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Magnetic: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Reveal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Stagger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TiltCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/decor/CartoonMascot', () => ({
  CartoonMascot: () => null,
}));

vi.mock('@/hooks/queries', () => ({
  useStats: () => ({
    data: {
      bookmarks: 12,
      tags: 5,
      favorites: 3,
      archived: 2,
      trashed: 1,
      untagged: 4,
      addedLast7Days: 6,
      categorized: 8,
      uncategorized: 4,
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useBookmarks: () => ({ data: { pages: [{ items: [] }] }, isLoading: false, isError: false }),
  useTags: () => ({ data: [], isLoading: false }),
  useHealthReport: () => ({
    data: {
      liveTotal: 12,
      duplicateGroups: [],
      duplicateExtra: 2,
      orphanTags: [{ id: 't1', name: '孤儿' }],
      score: 72,
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

function renderAt(entry = '/dashboard') {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          {/* Landing targets — reaching them proves the click navigates. */}
          <Route path="/library/inbox" element={<div>INBOX_LANDED</div>} />
          <Route path="/library/trash" element={<div>TRASH_LANDED</div>} />
          <Route path="/library/archive" element={<div>ARCHIVE_LANDED</div>} />
          <Route path="/organize" element={<div>ORGANIZE_LANDED</div>} />
          <Route path="/import" element={<div>IMPORT_LANDED</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardPage navigation (click-through regression)', () => {
  beforeEach(() => {
    queryClient.clear();
  });

  it('clicking the 收件箱 attention card navigates to the inbox', async () => {
    const user = userEvent.setup();
    renderAt();
    // Matches both the attention card and the quick-entry link; both must land
    // in the inbox, so the first (attention card) is the one under test.
    await user.click(screen.getAllByRole('link', { name: /收件箱/ })[0]);
    expect(screen.getByText('INBOX_LANDED')).toBeInTheDocument();
  });

  it('clicking the 回收站 attention card navigates to the trash', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getAllByRole('link', { name: /回收站/ })[0]);
    expect(screen.getByText('TRASH_LANDED')).toBeInTheDocument();
  });

  it('clicking the 书签体检 action button navigates to organize', async () => {
    const user = userEvent.setup();
    renderAt();
    // issues > 0 in the mock → the button reads 去清理.
    await user.click(screen.getByRole('button', { name: /去清理/ }));
    expect(screen.getByText('ORGANIZE_LANDED')).toBeInTheDocument();
  });

  it('clicking the hero 添加书签 button navigates to the inbox', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByRole('button', { name: /添加书签/ }));
    expect(screen.getByText('INBOX_LANDED')).toBeInTheDocument();
  });

  it('clicking the hero 导入书签 button navigates to import', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByRole('button', { name: /导入书签/ }));
    expect(screen.getByText('IMPORT_LANDED')).toBeInTheDocument();
  });
});

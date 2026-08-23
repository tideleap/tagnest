/**
 * CS-P5-3 — CategoryView drag-to-reclassify (C2-3).
 *
 * Renders CategoryView with a stubbed writeback feed + assign mutation, then
 * simulates a drop of a bookmark onto a category section (level-1) and onto a
 * level-2 child bucket, asserting the PRIMARY-category assignment fires with the
 * correct tagId in each case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CategoryView } from './CategoryView';
import type { Bookmark, Tag } from '@shared/types';

const assignSpy = vi.fn();

// The stubbed hook implementation is mutable so each test can feed a different
// writeback payload without re-mocking.
const writebackImpl = vi.fn();

const fixture = {
  bookmark: {
    id: 'b1',
    url: 'https://react.dev',
    title: 'React 文档',
    description: null,
    faviconUrl: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    isFavorite: false,
    isArchived: false,
  } as unknown as Bookmark,
  frontend: {
    id: 't-fe',
    name: '前端开发',
    count: 1,
    colorIndex: 0,
    parentId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as Tag,
  react: {
    id: 't-react',
    name: 'React',
    count: 1,
    colorIndex: 1,
    parentId: 't-fe',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as Tag,
};

vi.mock('@/hooks/queries/category', () => ({
  useCategoryWriteback: () => writebackImpl(),
  useAssignCategory: () => ({ mutate: assignSpy, isPending: false }),
}));

// BookmarkCard pulls in collection + snapshot hooks that would otherwise fire
// real network requests under happy-dom. Stub the api layer so every call
// resolves to an empty payload — the test only cares about the drop handler.
vi.mock('@/lib/api', () => ({
  api: {
    get: () => Promise.resolve({ data: {} }),
    post: () => Promise.resolve({ data: {} }),
  },
}));

function setWriteback(items: Array<{ bookmarkId: string; categoryPath: string[]; tagId: string }>) {
  writebackImpl.mockReturnValue({
    data: { pages: [{ items, nextCursor: null }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
}

function renderView(bookmarks: Bookmark[], tags: Tag[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handlers = {
    onToggleSelect: vi.fn(),
    onEdit: vi.fn(),
    onToggleFavorite: vi.fn(),
    onArchive: vi.fn(),
    onTrash: vi.fn(),
    onRestore: vi.fn(),
    onPurge: vi.fn(),
    onVisit: vi.fn(),
    onTagClick: vi.fn(),
    onSetPrivate: vi.fn(),
  };
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CategoryView
          bookmarks={bookmarks}
          tags={tags}
          selected={new Set()}
          selectionActive={false}
          handlers={handlers}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  assignSpy.mockReset();
  writebackImpl.mockReset();
});

describe('CategoryView — drag-to-reclassify (C2-3)', () => {
  it('assigns a dropped bookmark to the hovered category section (level-1)', () => {
    setWriteback([{ bookmarkId: 'b1', categoryPath: ['前端开发'], tagId: 't-fe' }]);
    renderView([fixture.bookmark], [fixture.frontend]);

    const section = screen.getByText('前端开发').closest('section')!;
    fireEvent.drop(section, {
      dataTransfer: { getData: () => 'b1', dropEffect: 'move' },
    });

    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith({ bookmarkIds: ['b1'], tagId: 't-fe' });
  });

  it('assigns to the level-2 child bucket, not the parent section', () => {
    setWriteback([{ bookmarkId: 'b1', categoryPath: ['前端开发', 'React'], tagId: 't-react' }]);
    renderView([fixture.bookmark], [fixture.frontend, fixture.react]);

    // The "React" sub-bucket title lives in its own drop container.
    const childBucket = screen.getByText('React').closest('div')!;
    fireEvent.drop(childBucket, {
      dataTransfer: { getData: () => 'b1', dropEffect: 'move' },
    });

    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith({ bookmarkIds: ['b1'], tagId: 't-react' });
    expect(assignSpy).not.toHaveBeenCalledWith({ bookmarkIds: ['b1'], tagId: 't-fe' });
  });
});

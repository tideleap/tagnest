import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Bookmark, SimilarBookmarks as SimilarPayload } from '@shared/types';
import { SimilarBookmarks } from './SimilarBookmarks';
import { useOverlay } from '@/stores/ui';

const mocks = vi.hoisted(() => ({
  similar: { data: null as SimilarPayload | null, isLoading: false, isError: false },
}));

vi.mock('@/hooks/queries', () => ({
  useSimilarBookmarks: () => mocks.similar,
}));

function makeBookmark(id: string, title: string, url: string): Bookmark {
  return {
    id,
    url,
    title,
    description: null,
    note: null,
    faviconUrl: null,
    coverUrl: null,
    snapshotKey: null,
    snapshotKeys: [],
    aiSummary: null,
    isFavorite: false,
    isArchived: false,
    visitCount: 0,
    lastVisitedAt: null,
    manualOrder: 0,
    tags: [
      {
        id: 't1',
        name: 'react',
        colorIndex: 0,
        parentId: null,
        sortOrder: 0,
        count: 2,
        isPrivate: false,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
  };
}

function seedItems(): Bookmark[] {
  return [
    makeBookmark('b2', 'React API', 'https://react.dev/api'),
    makeBookmark('b3', 'React Hooks', 'https://react.dev/hooks'),
  ];
}

describe('SimilarBookmarks', () => {
  it('shows the section heading and skeletons while loading', () => {
    mocks.similar = { data: null, isLoading: true, isError: false };
    render(<SimilarBookmarks id="b1" />);
    expect(screen.getByText('相关书签')).toBeInTheDocument();
    expect(screen.queryByText('React API')).not.toBeInTheDocument();
  });

  it('renders ranked items with title, host and tags, and jumps to edit on click', () => {
    mocks.similar = { data: { items: seedItems(), total: 2 }, isLoading: false, isError: false };
    const spy = vi.spyOn(useOverlay.getState(), 'setEditingBookmarkId');
    try {
      render(<SimilarBookmarks id="b1" />);

      expect(screen.getByText('React API')).toBeInTheDocument();
      expect(screen.getAllByText('react.dev').length).toBe(2);
      expect(screen.getAllByText('react').length).toBe(2);

      fireEvent.click(screen.getByText('React API'));
      expect(spy).toHaveBeenCalledWith('b2');
    } finally {
      spy.mockRestore();
    }
  });

  it('renders a calm empty state when nothing is similar', () => {
    mocks.similar = { data: { items: [], total: 0 }, isLoading: false, isError: false };
    render(<SimilarBookmarks id="b1" />);
    expect(screen.getByText('暂时没有足够相似的书签。')).toBeInTheDocument();
    expect(screen.queryByText('React API')).not.toBeInTheDocument();
  });

  it('surfaces an error message without throwing when the request fails', () => {
    mocks.similar = { data: null, isLoading: false, isError: true };
    render(<SimilarBookmarks id="b1" />);
    expect(screen.getByText('相关书签暂时无法加载。')).toBeInTheDocument();
  });
});

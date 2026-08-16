import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { CollectionDetail } from './CollectionDetail';
import { queryClient } from '@/lib/queryClient';
import type { CollectionKind, SavedSearchQuery } from '@shared/types';

const state = vi.hoisted(() => ({
  useCollectionData: {
    collection: {
      id: 'c1',
      name: '手动集合',
      colorIndex: 0,
      count: 2,
      kind: 'manual' as CollectionKind,
      query: null as SavedSearchQuery | null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    bookmarks: [{ id: 'b1', url: 'https://x.com', title: 'X', faviconUrl: null }],
  },
  tags: [
    { id: 't1', name: '设计', count: 3, colorIndex: 0, parentId: null, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z' },
  ],
}));

vi.mock('@/hooks/queries', () => ({
  useCollection: () => ({ data: state.useCollectionData, isLoading: false }),
  useTags: () => ({ data: state.tags, isLoading: false }),
  useAddToCollection: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateCollection: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCollection: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveFromCollection: () => ({ mutate: vi.fn(), isPending: false }),
  useRenameCollection: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderDetail(id: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/collections/${id}`]}>
        <Routes>
          <Route path="/collections/:id" element={<CollectionDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CollectionDetail (manual collection)', () => {
  it('shows the add-bookmark action and per-item remove', () => {
    state.useCollectionData = {
      collection: {
        id: 'c1',
        name: '手动集合',
        colorIndex: 0,
        count: 2,
        kind: 'manual',
        query: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      bookmarks: [{ id: 'b1', url: 'https://x.com', title: 'X', faviconUrl: null }],
    };
    renderDetail('c1');
    expect(screen.getByText('添加书签')).toBeInTheDocument();
    expect(screen.queryByText('智能集合')).not.toBeInTheDocument();
    expect(screen.getByLabelText('从集合移除')).toBeInTheDocument();
  });
});

describe('CollectionDetail (smart collection)', () => {
  it('hides manual membership controls and shows the live query summary', () => {
    state.useCollectionData = {
      collection: {
        id: 'c2',
        name: 'React 资源',
        colorIndex: 1,
        count: 3,
        kind: 'smart',
        query: {
          q: 'react',
          tagIds: [],
          matchAllTags: false,
          scope: 'all',
          sort: 'created_desc',
        },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      bookmarks: [{ id: 'b1', url: 'https://x.com', title: 'X', faviconUrl: null }],
    };
    renderDetail('c2');
    expect(screen.getByText('智能集合')).toBeInTheDocument(); // eyebrow
    expect(screen.queryByText('添加书签')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('从集合移除')).not.toBeInTheDocument();
    expect(screen.getByText('实时')).toBeInTheDocument(); // live badge
    expect(screen.getByText(/react/)).toBeInTheDocument(); // query summary
  });
});

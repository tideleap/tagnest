import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Tag } from '@shared/types';

// The page pulls many tag hooks; stub them so the test never hits the network
// and we can spy on the create mutation.
const createTagSpy = vi.fn();

vi.mock('@/hooks/queries', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/queries')>('@/hooks/queries');
  return {
    ...actual,
    useTags: () => ({
      data: SAMPLE_TAGS,
      isLoading: false,
      isError: false,
      error: undefined,
      refetch: vi.fn(),
    }),
    useCreateTag: () => ({ mutate: createTagSpy, isPending: false }),
    useUpdateTag: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteTag: () => ({ mutate: vi.fn(), isPending: false }),
    useMergeTags: () => ({ mutate: vi.fn(), isPending: false }),
    useSetTagPrivate: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { TagsPage } from './TagsPage';

const SAMPLE_TAGS: Tag[] = [
  {
    id: 'p1',
    name: '前端',
    parentId: null,
    colorIndex: 0,
    count: 3,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
    isPrivate: false,
  },
  {
    id: 'c1',
    name: 'React',
    parentId: 'p1',
    colorIndex: 1,
    count: 2,
    sortOrder: 0,
    createdAt: '2026-01-02T00:00:00Z',
    isPrivate: false,
  },
  {
    id: 't2',
    name: '设计',
    parentId: null,
    colorIndex: 2,
    count: 1,
    sortOrder: 0,
    createdAt: '2026-01-03T00:00:00Z',
    isPrivate: false,
  },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <TagsPage />
    </MemoryRouter>,
  );
}

describe('TagsPage · 嵌套标签', () => {
  beforeEach(() => createTagSpy.mockClear());

  it('新建标签对话框提供父级选择，提交时带上 parentId', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: '新建标签' }));

    // The dialog exposes a parent picker.
    const parentSelect = await screen.findByLabelText('父级');
    expect(parentSelect).toBeInTheDocument();

    await user.type(screen.getByLabelText('名称'), '组件');
    await user.selectOptions(parentSelect, 'p1');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(createTagSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: '组件', parentId: 'p1' }),
      expect.anything(),
    );
  });

  it('父级选择默认为（顶级标签）即 parentId = null', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: '新建标签' }));

    const parentSelect = await screen.findByLabelText('父级');
    expect((parentSelect as HTMLSelectElement).value).toBe('');
  });
});

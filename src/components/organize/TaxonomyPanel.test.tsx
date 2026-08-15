import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiTaxonomyAudit } from '@shared/types';
import { TaxonomyPanel } from './TaxonomyPanel';

// The panel pulls four hooks; stub them so the test drives state directly.
const mergeMutate = vi.fn();
const deleteMutate = vi.fn();
const bulkDeleteMutate = vi.fn();
let mergeLogData: unknown[] = [];

vi.mock('@/hooks/queries', () => ({
  useMergeTags: () => ({ mutate: mergeMutate, isPending: false }),
  useDeleteTag: () => ({ mutate: deleteMutate, isPending: false }),
  useBulkDeleteTags: () => ({ mutate: bulkDeleteMutate, isPending: false }),
  useMergeLog: () => ({ data: mergeLogData, isLoading: false }),
}));

// AliasSuggestions has its own query lifecycle; it is not under test here.
vi.mock('./AliasSuggestions', () => ({
  AliasSuggestions: () => <div data-testid="alias-suggestions" />,
}));

function makeAudit(overrides: Partial<AiTaxonomyAudit> = {}): AiTaxonomyAudit {
  return {
    totalTags: 10,
    clusters: [],
    unused: [],
    lowUsage: [],
    ...overrides,
  };
}

describe('TaxonomyPanel (tag governance)', () => {
  beforeEach(() => {
    mergeMutate.mockReset();
    deleteMutate.mockReset();
    bulkDeleteMutate.mockReset();
    mergeLogData = [];
  });

  it('shows the clean state when nothing needs attention', () => {
    render(<TaxonomyPanel audit={makeAudit()} />);
    expect(screen.getByText('标签体系很干净')).toBeInTheDocument();
  });

  it('offers one-click merge-all across duplicate clusters', async () => {
    const user = userEvent.setup();
    const audit = makeAudit({
      clusters: [
        {
          canonicalId: 'js',
          canonicalName: 'JavaScript',
          canonicalCount: 12,
          duplicates: [{ id: 'jsdup', name: 'js', count: 3 }],
          reason: '大小写',
        },
        {
          canonicalId: 'css',
          canonicalName: 'CSS',
          canonicalCount: 8,
          duplicates: [{ id: 'cssdup', name: 'css2', count: 1 }],
          reason: '相似',
        },
      ],
    });
    render(<TaxonomyPanel audit={audit} />);

    await user.click(screen.getByRole('button', { name: /一键全部合并/ }));
    expect(mergeMutate).toHaveBeenCalledWith({
      clusters: [
        { sourceIds: ['jsdup'], targetId: 'js' },
        { sourceIds: ['cssdup'], targetId: 'css' },
      ],
    });
  });

  it('hides merge-all for a single cluster (nothing to batch)', () => {
    const audit = makeAudit({
      clusters: [
        {
          canonicalId: 'js',
          canonicalName: 'JavaScript',
          canonicalCount: 12,
          duplicates: [{ id: 'jsdup', name: 'js', count: 3 }],
          reason: '大小写',
        },
      ],
    });
    render(<TaxonomyPanel audit={audit} />);
    expect(screen.queryByRole('button', { name: /一键全部合并/ })).not.toBeInTheDocument();
    // The per-cluster merge button is still there.
    expect(screen.getByRole('button', { name: /合并/ })).toBeInTheDocument();
  });

  it('bulk-clears unused tags behind a confirmation', async () => {
    const user = userEvent.setup();
    const audit = makeAudit({
      unused: [
        { id: 'u1', name: '旧标签一' },
        { id: 'u2', name: '旧标签二' },
      ],
    });
    render(<TaxonomyPanel audit={audit} />);

    await user.click(screen.getByRole('button', { name: /全部清理/ }));
    // Confirmation dialog names the count and the irreversibility.
    expect(screen.getByText(/确定删除全部 2 个未使用标签吗/)).toBeInTheDocument();
    expect(bulkDeleteMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '全部删除' }));
    expect(bulkDeleteMutate).toHaveBeenCalledWith(['u1', 'u2']);
  });

  it('lists low-usage tags as governance candidates', () => {
    const audit = makeAudit({
      lowUsage: [{ id: 'l1', name: '小众工具', count: 1 }],
    });
    render(<TaxonomyPanel audit={audit} />);
    expect(screen.getByText('低频标签')).toBeInTheDocument();
    expect(screen.getByText('小众工具')).toBeInTheDocument();
  });

  it('renders the merge audit trail newest-first', () => {
    mergeLogData = [
      {
        id: 'm2',
        targetTagId: 'css',
        targetTagName: 'CSS',
        sourceTagNames: ['css2'],
        mergedCount: 1,
        createdAt: '2026-02-01T00:00:00Z',
      },
      {
        id: 'm1',
        targetTagId: 'js',
        targetTagName: 'JavaScript',
        sourceTagNames: ['js', 'JS'],
        mergedCount: 2,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const audit = makeAudit({
      unused: [{ id: 'u1', name: '旧标签' }], // keep the panel out of clean state
    });
    render(<TaxonomyPanel audit={audit} />);
    expect(screen.getByText('合并历史')).toBeInTheDocument();
    expect(screen.getByText('css2')).toBeInTheDocument();
    expect(screen.getByText('JavaScript')).toBeInTheDocument();
  });
});

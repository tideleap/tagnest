import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiSuggestion } from '@shared/types';
import { SuggestionReview } from './SuggestionReview';

// The review queue drives decisions through one hook; stub it so the test can
// assert what payload each accept/reject sends to the server.
const decideMutate = vi.fn();

vi.mock('@/hooks/queries/organize', () => ({
  useDecideSuggestions: () => ({ mutate: decideMutate, isPending: false }),
}));

function suggestion(overrides: Partial<AiSuggestion> = {}): AiSuggestion {
  return {
    id: 's1',
    bookmarkId: 'b1',
    bookmarkTitle: 'React 官方文档',
    bookmarkUrl: 'https://react.dev',
    tagName: '开发技术 > 前端开发',
    tagId: 'tag-frontend',
    confidence: 0.92,
    source: 'model',
    reason: '页面主题为前端框架',
    topic: '前端',
    needsReview: false,
    feedbackBoosted: false,
    createdAt: '2026-08-22T00:00:00Z',
    category: '开发技术',
    subcategory: '前端开发',
    kind: 'category',
    ...overrides,
  };
}

describe('SuggestionReview (CategorySync C2-2 category queue)', () => {
  beforeEach(() => {
    decideMutate.mockReset();
  });

  it('renders the category path as the proposal label', () => {
    render(<SuggestionReview suggestions={[suggestion()]} kind="category" />);
    // The full path is the visible proposal text.
    expect(screen.getByText('开发技术 > 前端开发')).toBeInTheDocument();
  });

  it('counts proposals as 分类, not 标签, in the header', () => {
    render(<SuggestionReview suggestions={[suggestion()]} kind="category" />);
    expect(screen.getByText(/1 个待确认分类/)).toBeInTheDocument();
  });

  it('sends kind=category when accepting a single proposal', async () => {
    const user = userEvent.setup();
    render(<SuggestionReview suggestions={[suggestion()]} kind="category" />);

    await user.click(screen.getByRole('button', { name: /接受标签/ }));
    expect(decideMutate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'accept', ids: ['s1'], kind: 'category' }),
    );
  });

  it('sends kind=category when rejecting a single proposal', async () => {
    const user = userEvent.setup();
    render(<SuggestionReview suggestions={[suggestion()]} kind="category" />);

    await user.click(screen.getByRole('button', { name: /忽略标签/ }));
    expect(decideMutate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reject', ids: ['s1'], kind: 'category' }),
    );
  });

  it('hides the rename (pencil) control for category rows', () => {
    render(<SuggestionReview suggestions={[suggestion()]} kind="category" />);
    expect(screen.queryByRole('button', { name: /编辑标签/ })).not.toBeInTheDocument();
  });

  it('shows the rename control for tag rows', () => {
    render(
      <SuggestionReview
        suggestions={[suggestion({ kind: 'tag', tagName: 'React' })]}
        kind="tag"
      />,
    );
    expect(screen.getByRole('button', { name: /编辑标签/ })).toBeInTheDocument();
  });

  it('shows the category-specific empty state', () => {
    render(<SuggestionReview suggestions={[]} kind="category" />);
    expect(screen.getByText(/精确分类/)).toBeInTheDocument();
  });

  it('defaults to the tag queue when no kind is given', () => {
    render(<SuggestionReview suggestions={[suggestion({ kind: 'tag', tagName: 'React' })]} />);
    expect(screen.getByText(/1 个待确认标签/)).toBeInTheDocument();
  });
});

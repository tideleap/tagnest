import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { OrganizePage } from './OrganizePage';
import { queryClient } from '@/lib/queryClient';

// Capture the props the page hands to its two kind-aware children so the test
// can assert the organiser track flows through to them.
const captured = vi.hoisted(() => ({
  runPanelProps: [] as Array<{ kind?: string }>,
  reviewProps: [] as Array<{ kind?: string }>,
}));

vi.mock('@/components/organize/RunPanel', () => ({
  RunPanel: (props: { kind?: string }) => {
    captured.runPanelProps.push(props);
    return <div data-testid="run-panel" data-kind={props.kind} />;
  },
}));

vi.mock('@/components/organize/SuggestionReview', () => ({
  SuggestionReview: (props: { kind?: string }) => {
    captured.reviewProps.push(props);
    return <div data-testid="suggestion-review" data-kind={props.kind} />;
  },
}));

// Non-essential panels and hooks — stubbed to keep the test focused on the
// mode switch and the kind plumbing.
vi.mock('@/components/organize/AiMetricsPanel', () => ({ AiMetricsPanel: () => null }));
vi.mock('@/components/organize/EvaluationPanel', () => ({ EvaluationPanel: () => null }));
vi.mock('@/components/organize/TaxonomyPanel', () => ({ TaxonomyPanel: () => null }));
vi.mock('@/components/organize/AutoGroupPanel', () => ({ AutoGroupPanel: () => null }));
vi.mock('@/components/organize/HealthPanel', () => ({ HealthPanel: () => null }));
vi.mock('@/components/organize/CategoryExportPanel', () => ({
  CategoryExportPanel: () => null,
}));

const startMock = vi.fn().mockResolvedValue(null);

vi.mock('@/hooks/queries/organize', () => ({
  useAiOverview: () => ({
    data: {
      modelReady: true,
      pendingSuggestions: 3,
      untaggedBookmarks: 10,
      totalBookmarks: 100,
    },
  }),
  useAiSuggestions: () => ({
    data: { suggestions: [], total: 0 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useAiTaxonomyAudit: () => ({ data: undefined, isLoading: false }),
  useOrganizeRun: () => ({
    start: startMock,
    stop: vi.fn(),
    reset: vi.fn(),
    job: null,
    running: false,
    engine: null,
    modelError: null,
    autoApplied: 0,
    uncovered: 0,
    uncategorized: 0,
    error: null,
    topics: [],
    autoGrouped: null,
    rebalanceWarning: false,
    applying: false,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useTags: () => ({ data: [] }),
}));

function renderPage(initialEntry = '/organize') {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <OrganizePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OrganizePage (CategorySync categorize mode)', () => {
  beforeEach(() => {
    queryClient.clear();
    captured.runPanelProps.length = 0;
    captured.reviewProps.length = 0;
    startMock.mockClear();
  });

  it('defaults to the tagging track', () => {
    renderPage();
    const panel = screen.getByTestId('run-panel');
    expect(panel).toHaveAttribute('data-kind', 'tagging');
  });

  it('lands on the categorize track via ?mode=category (C2-5 deep link)', () => {
    renderPage('/organize?mode=category');
    const panel = screen.getByTestId('run-panel');
    expect(panel).toHaveAttribute('data-kind', 'categorize');
  });

  it('switches to categorize when the mode control is clicked', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('radio', { name: '精确分类' }));
    expect(screen.getByTestId('run-panel')).toHaveAttribute('data-kind', 'categorize');
  });

  it('scopes the review queue to category suggestions in categorize mode', async () => {
    const user = userEvent.setup();
    renderPage('/organize?mode=category');
    // Move to the review tab to mount SuggestionReview.
    await user.click(screen.getByRole('radio', { name: /确认/ }));
    expect(screen.getByTestId('suggestion-review')).toHaveAttribute('data-kind', 'category');
  });

  it('scopes the review queue to tag suggestions in tagging mode', async () => {
    const user = userEvent.setup();
    renderPage('/organize');
    await user.click(screen.getByRole('radio', { name: /确认/ }));
    expect(screen.getByTestId('suggestion-review')).toHaveAttribute('data-kind', 'tag');
  });
});

describe('OrganizePage (2026-08-30 hero redesign)', () => {
  beforeEach(() => {
    queryClient.clear();
    captured.runPanelProps.length = 0;
    captured.reviewProps.length = 0;
    startMock.mockClear();
  });

  it('renders the hero run card above the fold — RunPanel mounts on initial view without switching tabs', () => {
    renderPage();
    // The run panel is mounted immediately (hero), no tab click needed.
    expect(screen.getByTestId('run-panel')).toBeInTheDocument();
    // The hero card shows the active track title.
    expect(screen.getByRole('heading', { name: '标签整理' })).toBeInTheDocument();
  });

  it('shows the four-cell stat strip with pending confirmations as a clickable card', async () => {
    const user = userEvent.setup();
    renderPage();
    const pendingCell = screen.getByTitle('点击进入确认队列');
    expect(pendingCell).toHaveTextContent('待确认');
    expect(pendingCell).toHaveTextContent('3');
    // Clicking it jumps straight to the review tab.
    await user.click(pendingCell);
    expect(screen.getByTestId('suggestion-review')).toBeInTheDocument();
  });

  it('hosts the metric cards in the insights tab instead of the initial view', async () => {
    const user = userEvent.setup();
    renderPage();
    // Switch to the insights tab; EvaluationPanel is mocked to null but the
    // tab radio must exist and be selectable.
    await user.click(screen.getByRole('radio', { name: /效果数据/ }));
    expect(screen.getByRole('radio', { name: /效果数据/ })).toHaveAttribute('aria-checked', 'true');
  });
});

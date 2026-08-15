import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReportPage } from './ReportPage';
import { queryClient } from '@/lib/queryClient';

// The page is a pure composition layer over five hooks; stub each so the test
// drives the exact data shapes without touching the network. vi.hoisted keeps
// the fixtures usable inside the hoisted factory bodies.
const fixtures = vi.hoisted(() => {
  const statsData = {
    bookmarks: 120,
    tags: 30,
    favorites: 12,
    archived: 5,
    trashed: 2,
    untagged: 8,
    addedLast7Days: 4,
  };

  const healthData = {
    liveTotal: 120,
    duplicateGroups: [{ urls: ['a'], ids: ['1', '2'] }],
    duplicateExtra: 1,
    orphanTags: [{ id: 't1', name: '孤儿' }],
    score: 86,
  };

  const overviewData = {
    modelReady: true,
    pendingSuggestions: 0,
    untaggedBookmarks: 8,
    totalBookmarks: 120,
    aiTagLinks: 40,
    userTagLinks: 60,
    recentJobs: [],
    feedback: { acceptanceRate: 0.72 },
    feedbackTrend: [],
    promptVersion: 'v1',
    usage: {},
    contribution: { weightedRate: 0.35 },
  };

  // 20 tags → top 15 shown, the rest folded into "其他".
  const tagsData = Array.from({ length: 20 }, (_, i) => ({
    id: `t${i}`,
    name: `标签${i}`,
    count: 20 - i,
    colorIndex: 0,
    parentId: null,
    sortOrder: i,
    createdAt: '2026-01-01T00:00:00Z',
  }));

  const trendData = {
    days: [
      { date: '2026-08-01', count: 3 },
      { date: '2026-08-02', count: 1 },
    ],
  };

  return { statsData, healthData, overviewData, tagsData, trendData };
});

vi.mock('@/hooks/queries', () => ({
  useStats: () => ({ data: fixtures.statsData, isLoading: false }),
  useStatsTrend: () => ({ data: fixtures.trendData, isLoading: false }),
  useTags: () => ({ data: fixtures.tagsData, isLoading: false }),
}));

vi.mock('@/hooks/queries/health', () => ({
  useHealthReport: () => ({ data: fixtures.healthData, isLoading: false }),
}));

vi.mock('@/hooks/queries/organize', () => ({
  useAiOverview: () => ({ data: fixtures.overviewData, isLoading: false }),
}));

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/report']}>
        <ReportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReportPage (A3 statistics report)', () => {
  beforeEach(() => {
    queryClient.clear();
  });

  it('renders the headline numbers', () => {
    renderPage();
    expect(screen.getByText('书签总数')).toBeInTheDocument();
    // 120 appears in both the headline and the scale strip.
    expect(screen.getAllByText('120').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('近 7 天新增')).toBeInTheDocument();
    expect(screen.getAllByText('健康分').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the collection trend summary', () => {
    renderPage();
    expect(screen.getByText('收藏趋势')).toBeInTheDocument();
    // 3 + 1 = 4 total in the window; peak day is 3.
    expect(screen.getByText(/窗口内共新增/)).toBeInTheDocument();
  });

  it('folds tags beyond the top 15 into 其他', () => {
    renderPage();
    expect(screen.getByText('标签分布')).toBeInTheDocument();
    // Top tag present, 16th onward folded.
    expect(screen.getByText('标签0')).toBeInTheDocument();
    expect(screen.queryByText('标签15')).not.toBeInTheDocument();
    expect(screen.getByText('其他')).toBeInTheDocument();
  });

  it('shows AI contribution with the weighted rate', () => {
    renderPage();
    expect(screen.getByText('AI 贡献度')).toBeInTheDocument();
    expect(screen.getByText('35%')).toBeInTheDocument(); // weightedRate 0.35
    expect(screen.getByText('72%')).toBeInTheDocument(); // acceptanceRate 0.72
  });

  it('shows the health summary with score and counts', () => {
    renderPage();
    expect(screen.getByText('库健康度')).toBeInTheDocument();
    // 86 + 良好 appear in both the headline badge and the health card.
    expect(screen.getAllByText('86').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('良好').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the library scale strip', () => {
    renderPage();
    expect(screen.getByText('库规模')).toBeInTheDocument();
    expect(screen.getByText('活跃')).toBeInTheDocument();
    expect(screen.getByText('回收站')).toBeInTheDocument();
  });
});

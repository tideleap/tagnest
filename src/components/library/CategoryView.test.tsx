import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Bookmark, Tag } from '@shared/types';

// CategoryView streams primary-category placements via an infinite query and
// records visits on open. Stub both so the test renders without a network and
// we never depend on a populated writeback feed.
//
// We expose the writeback hook as a controllable `vi.fn` (via `vi.hoisted`) so
// individual tests can inject a category placement map and drive the
// in-category search through the real data path. The default return mirrors
// the original stub (`{ pages: [] }`) so the pre-existing tests keep passing.
const { mockCategoryWriteback } = vi.hoisted(() => ({
  mockCategoryWriteback: vi.fn(),
}));

vi.mock('@/hooks/queries/category', () => ({
  useCategoryWriteback: () => mockCategoryWriteback(),
}));

vi.mock('@/hooks/queries', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/queries')>('@/hooks/queries');
  return {
    ...actual,
    useRecordVisit: () => ({ mutate: vi.fn() }),
  };
});

import { CategoryView } from './CategoryView';

const EMPTY_WRITEBACK = {
  data: { pages: [] as { items: { bookmarkId: string; url: string; title: string; categoryPath: string[] | null }[]; nextCursor: null; total: number }[] },
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
};

const MOCK_TAG: Tag = {
  id: 't1',
  name: '开发技术',
  parentId: null,
  colorIndex: 0,
  count: 1,
  sortOrder: 0,
  isPrivate: false,
  createdAt: '2026-01-01T00:00:00Z',
};

const MOCK_BOOKMARK: Bookmark = {
  id: 'b1',
  url: 'https://example.com',
  title: 'Example Site',
  description: null,
  faviconUrl: null,
  coverUrl: null,
  snapshotKey: null,
  snapshotKeys: [],
  note: null,
  aiSummary: null,
  isFavorite: false,
  isArchived: false,
  visitCount: 5,
  lastVisitedAt: null,
  manualOrder: 0,
  tags: [],
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  deletedAt: null,
};

function renderView(bookmarks: Bookmark[] = [MOCK_BOOKMARK], tags: Tag[] = [MOCK_TAG]) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CategoryView bookmarks={bookmarks} tags={tags} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Feed the writeback feed with explicit category placements for a test. */
function setWritebackWithCategories(
  items: { bookmarkId: string; url: string; title: string; categoryPath: string[] | null }[],
) {
  mockCategoryWriteback.mockReturnValue({
    data: { pages: [{ items, nextCursor: null, total: items.length }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
}

beforeEach(() => {
  localStorage.clear();
  mockCategoryWriteback.mockReturnValue(EMPTY_WRITEBACK);
});

describe('CategoryView · 全部 tab 门户增强', () => {
  it('渲染 Hero 问候语、总书签统计与常用区标题', () => {
    renderView();

    // The Hero greeting is time-of-day dependent but always one of these.
    expect(
      screen.getByText(/^(早上好|中午好|下午好|晚上好|深夜好)$/),
    ).toBeInTheDocument();

    // Hero stat cards.
    expect(screen.getByText('总书签')).toBeInTheDocument();
    expect(screen.getByText('今日新增')).toBeInTheDocument();
    expect(screen.getByText('本周访问')).toBeInTheDocument();

    // Quick-access strip heading.
    expect(screen.getByText('常用 / 最近访问')).toBeInTheDocument();

    // Recently-added strip heading.
    expect(screen.getByText('最近添加')).toBeInTheDocument();
  });

  it('总书签统计等于传入书签数量', () => {
    renderView();
    // The total stat value renders next to the "总书签" label.
    const label = screen.getByText('总书签');
    const card = label.closest('div');
    expect(card).toHaveTextContent('总书签');
    expect(card).toHaveTextContent('1');
  });
});

describe('CategoryView · Hero 问候语时段边界 (greetingFor)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // [hour, expected greeting] — covers the documented boundaries 5/11/13/18/23.
  const cases: [number, string][] = [
    [5, '早上好'],
    [10, '早上好'],
    [11, '中午好'],
    [12, '中午好'],
    [13, '下午好'],
    [17, '下午好'],
    [18, '晚上好'],
    [22, '晚上好'],
    [23, '深夜好'],
    [0, '深夜好'],
    [4, '深夜好'],
  ];

  it.each(cases)('hour=%i 渲染「%s」', (hour, expected) => {
    vi.setSystemTime(new Date(2026, 4, 1, hour, 0, 0));
    renderView();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

describe('CategoryView · 今日新增统计 (isSameDayIso 行为)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('今天创建的书签计入「今日新增」，昨天的不计入', () => {
    vi.setSystemTime(new Date(2026, 7, 1, 12, 0, 0)); // 2026-08-01 12:00 (local)
    const todayIso = new Date().toISOString();
    // 36h back guarantees we cross local midnight even with a timezone offset.
    const yesterdayIso = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

    const bookmarks: Bookmark[] = [
      { ...MOCK_BOOKMARK, id: 'b-today', createdAt: todayIso, visitCount: 0 },
      { ...MOCK_BOOKMARK, id: 'b-yest', createdAt: yesterdayIso, visitCount: 0 },
    ];
    renderView(bookmarks);

    const card = screen.getByText('今日新增').closest('div');
    expect(card).toHaveTextContent('1');
  });

  it('没有任何今天创建的书签时「今日新增」为 0', () => {
    vi.setSystemTime(new Date(2026, 7, 1, 12, 0, 0));
    const yesterdayIso = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

    const bookmarks: Bookmark[] = [
      { ...MOCK_BOOKMARK, id: 'b-yest', createdAt: yesterdayIso, visitCount: 0 },
    ];
    renderView(bookmarks);

    const card = screen.getByText('今日新增').closest('div');
    expect(card).toHaveTextContent('0');
  });
});

describe('CategoryView · 分类内即时搜索 (filterItems / matchesQuery)', () => {
  const SEARCH_TAGS: Tag[] = [{ ...MOCK_TAG, id: 't-tech', name: '技术' }];
  const SEARCH_BOOKMARKS: Bookmark[] = [
    { ...MOCK_BOOKMARK, id: 'b1', title: 'Example Site', url: 'https://example.com', visitCount: 1, createdAt: '2026-08-01T10:00:00Z' },
    { ...MOCK_BOOKMARK, id: 'b2', title: 'GitHub', url: 'https://github.com', visitCount: 1, createdAt: '2026-08-01T10:00:00Z' },
    // host/url «bbc.com» is searchable even though the title is in Chinese.
    { ...MOCK_BOOKMARK, id: 'b3', title: '英国广播公司', url: 'https://www.bbc.com/news', visitCount: 1, createdAt: '2026-08-01T10:00:00Z' },
  ];

  async function openTechTab() {
    setWritebackWithCategories([
      { bookmarkId: 'b1', url: 'https://example.com', title: 'Example Site', categoryPath: ['技术'] },
      { bookmarkId: 'b2', url: 'https://github.com', title: 'GitHub', categoryPath: ['技术'] },
      { bookmarkId: 'b3', url: 'https://www.bbc.com/news', title: '英国广播公司', categoryPath: ['技术'] },
    ]);
    const user = userEvent.setup();
    renderView(SEARCH_BOOKMARKS, SEARCH_TAGS);
    // Scope the click to the sticky tab bar so we hit the tab pill, not the
    // CategoryBlock "技术" button that also exists on the 全部 tab.
    const tabBar = screen.getByRole('button', { name: '全部' }).closest('div') as HTMLElement;
    await user.click(within(tabBar).getByRole('button', { name: '技术' }));

    // Sanity: on a single category all three tiles show, plus the HotRanking rail (3 links).
    expect(screen.getByText('常用站点')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(6);
    return user;
  }

  it('输入关键词只保留命中的书签（标题 / 网址 / 域名）', async () => {
    const user = await openTechTab();

    // Matches by title.
    await user.type(screen.getByPlaceholderText('在当前分类内搜索'), 'github');
    expect(screen.getByText('常用站点')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(4); // 3 hot + 1 filtered
    expect(screen.queryByText(/没有匹配/)).not.toBeInTheDocument();

    // Matches by url/host even when the needle is absent from the title.
    await user.clear(screen.getByPlaceholderText('在当前分类内搜索'));
    await user.type(screen.getByPlaceholderText('在当前分类内搜索'), 'bbc');
    expect(screen.getByText('常用站点')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });

  it('搜索不区分大小写', async () => {
    const user = await openTechTab();

    await user.type(screen.getByPlaceholderText('在当前分类内搜索'), 'EXAMPLE');
    expect(screen.getByText('常用站点')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(screen.queryByText(/没有匹配/)).not.toBeInTheDocument();
  });

  it('无匹配时显示空状态文案并隐藏区块', async () => {
    const user = await openTechTab();

    await user.type(screen.getByPlaceholderText('在当前分类内搜索'), 'zzzzz');
    // The "常用站点" block renders nothing (returns null) when filtered to zero.
    expect(screen.queryByText('常用站点')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(3); // only HotRanking remains
    expect(screen.getByText('没有匹配「zzzzz」的书签，换个关键词试试。')).toBeInTheDocument();
  });

  it('清空搜索恢复全部书签', async () => {
    const user = await openTechTab();

    const search = screen.getByPlaceholderText('在当前分类内搜索');
    await user.type(search, 'example');
    expect(screen.getAllByRole('link')).toHaveLength(4);

    await user.clear(search);
    // Empty query => filterItems returns the list untouched.
    expect(screen.getByText('常用站点')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(6);
  });
});

describe('CategoryView · 常用区固定 (pickQuickAccess / load·savePinnedIds)', () => {
  const QA_BOOKMARKS: Bookmark[] = [
    { ...MOCK_BOOKMARK, id: 'b-a', title: 'Alpha', url: 'https://alpha.com', visitCount: 10 },
    { ...MOCK_BOOKMARK, id: 'b-b', title: 'Bravo', url: 'https://bravo.com', visitCount: 30 },
    { ...MOCK_BOOKMARK, id: 'b-c', title: 'Charlie', url: 'https://charlie.com', visitCount: 5 },
  ];

  function qaSection() {
    // The QuickAccess strip is a <section> headed by 「常用 / 最近访问」.
    return screen.getByRole('heading', { name: '常用 / 最近访问' }).closest('section') as HTMLElement;
  }

  function qaLinks() {
    return within(qaSection()).getAllByRole('link');
  }

  it('未固定时按访问频次降序排列', () => {
    renderView(QA_BOOKMARKS);
    const links = qaLinks();
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveTextContent('Bravo'); // 30 visits
    expect(links[1]).toHaveTextContent('Alpha'); // 10 visits
    expect(links[2]).toHaveTextContent('Charlie'); // 5 visits
  });

  it('点击固定后该固定项置顶并写入 localStorage', async () => {
    const user = userEvent.setup();
    renderView(QA_BOOKMARKS);

    // Pin the lowest-visited item.
    await user.click(screen.getByRole('button', { name: '固定 Charlie' }));

    const links = qaLinks();
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveTextContent('Charlie'); // now pinned to the top

    // Persisted, and the toggle label flips to unpin.
    expect(localStorage.getItem('tagnest.pinnedQuickAccess')).toBe(JSON.stringify(['b-c']));
    expect(screen.getByRole('button', { name: '取消固定 Charlie' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '固定 Charlie' })).not.toBeInTheDocument();
  });

  it('固定项超出 QUICK_LIMIT 仍全部显示，且初始从 localStorage 读取固定顺序', () => {
    // Seed 9 pinned ids ( > QUICK_LIMIT of 8 ) before mount.
    const ids = Array.from({ length: 9 }, (_, i) => `b-${i}`);
    localStorage.setItem('tagnest.pinnedQuickAccess', JSON.stringify(ids));

    const bookmarks: Bookmark[] = ids.map((id, i) => ({
      ...MOCK_BOOKMARK,
      id,
      title: `Site ${i}`,
      url: `https://site-${i}.com`,
      visitCount: 0,
    }));
    renderView(bookmarks);

    const links = qaLinks();
    expect(links).toHaveLength(9); // every pinned bookmark is shown despite exceeding the limit

    // Pinned order is preserved from localStorage.
    expect(links[0]).toHaveTextContent('Site 0');
    expect(links[8]).toHaveTextContent('Site 8');

    // All toggles read as already-pinned.
    expect(screen.getByRole('button', { name: '取消固定 Site 0' })).toBeInTheDocument();
  });
});

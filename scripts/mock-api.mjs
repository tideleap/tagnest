// Minimal mock API for reproducing the dashboard click issue in a real browser.
// Serves just enough endpoints for DashboardPage to render fully.
import http from 'node:http';

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  // Auth refresh — pretend we have a session.
  if (p === '/api/auth/refresh') {
    return json(res, 200, {
      user: { id: 'u1', email: 'test@example.com', displayName: '测试用户' },
      accessToken: 'mock-token',
    });
  }

  if (p === '/api/stats') {
    return json(res, 200, {
      bookmarks: 12, tags: 5, favorites: 3, archived: 2, trashed: 1,
      untagged: 4, addedLast7Days: 6, categorized: 8, uncategorized: 4,
    });
  }

  if (p === '/api/bookmarks/health') {
    return json(res, 200, {
      liveTotal: 12, duplicateGroups: [], duplicateExtra: 2,
      orphanTags: [{ id: 't1', name: '孤儿标签' }], score: 72,
    });
  }

  if (p === '/api/bookmarks') {
    // 200 synthetic bookmarks with cursor pagination — large enough to expose
    // list-rendering jank that a single-item mock would hide.
    const all = Array.from({ length: 200 }, (_, i) => ({
      id: `b${i + 1}`,
      url: `https://example.com/page-${i + 1}`,
      title: `示例书签 ${i + 1}`,
      createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
      tags: i % 3 === 0 ? [{ id: 't1', name: '工作', colorIndex: 0 }] : [],
      isFavorite: i % 7 === 0,
      isArchived: false,
      isTrashed: false,
    }));
    const cursor = url.searchParams.get('cursor');
    const start = cursor ? Number(cursor) : 0;
    const pageSize = 50;
    const items = all.slice(start, start + pageSize);
    const next = start + pageSize;
    return json(res, 200, {
      items,
      nextCursor: next < all.length ? String(next) : null,
      total: all.length,
    });
  }

  if (p === '/api/tags') {
    return json(res, 200, [
      { id: 't1', name: '工作', colorIndex: 0, count: 5, parentId: null },
      { id: 't2', name: '学习', colorIndex: 1, count: 3, parentId: null },
    ]);
  }

  if (p === '/api/private/vault') {
    return json(res, 200, { configured: false, salt: null, verifier: null });
  }

  // AI overview — include the full aggregate shape; EvaluationPanel/AiMetricsPanel
  // used to crash on a bare `{}` (the old default below).
  if (p === '/api/ai/overview') {
    return json(res, 200, {
      modelReady: true,
      pendingSuggestions: 0,
      untaggedBookmarks: 4,
      totalBookmarks: 12,
      aiTagLinks: 6,
      userTagLinks: 9,
      recentJobs: [],
      feedback: {
        total: 0, accepted: 0, rejected: 0, modified: 0,
        acceptanceRate: 0, proposalTotal: 0, proposalAccepted: 0, hitRate: 0,
      },
      feedbackTrend: [],
      promptVersion: 'v2',
      usage: {
        adoptionRate: 0.25, touchedBookmarks: 3, totalBookmarks: 12,
        byScope: [], byEngine: [], runsLast30Days: 2, avgRunSize: 6,
        suggestionOutcome: { accepted: 1, rejected: 0, pending: 0, autoApplied: 0 },
      },
      contribution: {
        directAi: 4, assistedAi: 1, fallbackAi: 1, userOnly: 9,
        weightedRate: 0.34, acceptanceRate: 0.8, hitRate: 0.75,
        raw: { aiAccepted: 5, rejected: 1 },
      },
    });
  }

  // Default: empty success. NOTE: components must tolerate this shape for any
  // endpoint they consume — it is the contract-drift canary.
  return json(res, 200, {});
});

server.listen(8788, '127.0.0.1', () => {
  console.log('Mock API listening on http://127.0.0.1:8788');
});

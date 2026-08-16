// tests/feeds-endpoint.test.ts
//
// End-to-end tests of the RSS feed endpoints against the in-memory D1 mock.
// Feed fetching is driven by a stubbed global `fetch` so no network is touched;
// refreshFeed calls the real fetch (which we replace), exercising the full
// parse → dedupe → ensureTags → insert path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as listFeeds, onRequestPost as subscribeFeed } from '../functions/api/feeds/index';
import { onRequestDelete as unsubscribeFeed } from '../functions/api/feeds/[id]';
import { onRequestPost as refreshFeed } from '../functions/api/feeds/[id]/refresh';
import { onRequestPost as refreshAllFeeds } from '../functions/api/feeds/refresh-all';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';
const OTHER = 'u2';

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>测试源</title>
  <item><title>文章一</title><link>https://blog.example.com/posts/1</link><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate></item>
  <item><title>文章二</title><link>https://blog.example.com/posts/2</link></item>
</channel></rss>`;

function jsonCtx(env: Env, userId: string, method: string, body?: unknown, params: Record<string, string> = {}) {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request(`https://tagnest.test/api/feeds${params.id ? `/${params.id}` : ''}`, init),
    env,
    data: { userId },
    params,
  } as any;
}

let env: Env;
let db: MockDb;

beforeEach(() => {
  env = makeEnv();
  db = env.DB as MockDb;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(RSS_SAMPLE, { status: 200, headers: { 'content-type': 'application/rss+xml' } })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribe (POST /api/feeds)', () => {
  it('creates a feed and returns it with status "never"', async () => {
    const res = await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://blog.example.com/feed.xml', title: '我的博客' }));
    expect(res.status).toBe(201);
    const feed = await res.json();
    expect(feed.id).toBeTruthy();
    expect(feed.title).toBe('我的博客');
    expect(feed.url).toBe('https://blog.example.com/feed.xml');
    expect(feed.lastStatus).toBe('never');
    expect(db.feeds).toHaveLength(1);
  });

  it('rejects a non-URL with feed_invalid_url', async () => {
    await expect(subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'not-a-url' }))).rejects.toMatchObject({
      code: 'feed_invalid_url',
    });
  });

  it('rejects an internal/blocked host with feed_blocked_host', async () => {
    await expect(subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'http://localhost/feed' }))).rejects.toMatchObject({
      code: 'feed_blocked_host',
    });
  });

  it('ensures default tags on subscribe', async () => {
    await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://blog.example.com/feed.xml', tagNames: ['News'] }));
    expect(db.tags.some((t) => t.user_id === USER && String(t.name).toLowerCase() === 'news')).toBe(true);
  });
});

describe('list (GET /api/feeds)', () => {
  it('returns only the requesting user feeds', async () => {
    await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://blog.example.com/feed.xml' }));
    await subscribeFeed(jsonCtx(env, OTHER, 'POST', { url: 'https://other.example.com/feed.xml' }));
    const res = await listFeeds(jsonCtx(env, USER, 'GET'));
    const feeds = await res.json();
    expect(feeds).toHaveLength(1);
    expect(feeds[0].url).toBe('https://blog.example.com/feed.xml');
  });
});

describe('unsubscribe (DELETE /api/feeds/:id)', () => {
  it('removes the feed for the owner', async () => {
    const created = await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://blog.example.com/feed.xml' }));
    const id = (await created.json()).id;
    const res = await unsubscribeFeed(jsonCtx(env, USER, 'DELETE', undefined, { id }));
    expect(res.status).toBe(200);
    expect(db.feeds.find((f) => f.id === id)).toBeUndefined();
  });

  it('404s when the feed is not the user own', async () => {
    const created = await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://blog.example.com/feed.xml' }));
    const id = (await created.json()).id;
    await expect(unsubscribeFeed(jsonCtx(env, OTHER, 'DELETE', undefined, { id }))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('refresh (POST /api/feeds/:id/refresh)', () => {
  it('creates bookmarks from the feed and marks last_status ok', async () => {
    const created = await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://blog.example.com/feed.xml' }));
    const id = (await created.json()).id;
    const res = await refreshFeed(jsonCtx(env, USER, 'POST', undefined, { id }));
    const body = await res.json();
    expect(body.added).toBe(2);
    expect(body.skipped).toBe(0);
    expect(db.bookmarks).toHaveLength(2);
    expect(db.bookmarks.every((b) => b.user_id === USER)).toBe(true);
    const feed = db.feeds.find((f) => f.id === id)!;
    expect(feed.last_status).toBe('ok');
  });

  it('skips already-stored entries on a second refresh', async () => {
    const created = await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://blog.example.com/feed.xml' }));
    const id = (await created.json()).id;
    await refreshFeed(jsonCtx(env, USER, 'POST', undefined, { id }));
    const res = await refreshFeed(jsonCtx(env, USER, 'POST', undefined, { id }));
    const body = await res.json();
    expect(body.added).toBe(0);
    expect(body.skipped).toBe(2);
    expect(db.bookmarks).toHaveLength(2);
  });

  it('links new bookmarks to the feed default tag', async () => {
    const created = await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://blog.example.com/feed.xml', tagNames: ['News'] }));
    const id = (await created.json()).id;
    await refreshFeed(jsonCtx(env, USER, 'POST', undefined, { id }));
    const newsTag = db.tags.find((t) => t.user_id === USER && String(t.name).toLowerCase() === 'news')!;
    const links = db.bookmark_tags.filter((bt) => bt.tag_id === newsTag.id);
    expect(links).toHaveLength(2);
  });

  it('404s for an unknown feed', async () => {
    await expect(refreshFeed(jsonCtx(env, USER, 'POST', undefined, { id: 'missing' }))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('refresh-all (POST /api/feeds/refresh-all)', () => {
  it('refreshes only due (non-off) feeds', async () => {
    await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://blog.example.com/feed.xml', cadence: 'off' }));
    await subscribeFeed(jsonCtx(env, USER, 'POST', { url: 'https://daily.example.com/feed.xml', cadence: 'daily' }));
    const res = await refreshAllFeeds(jsonCtx(env, USER, 'POST'));
    const body = await res.json();
    // Only the 'daily' feed (last_fetched_at NULL → due) is refreshed.
    expect(body.refreshed).toBe(1);
    const offFeed = db.feeds.find((f) => f.url === 'https://blog.example.com/feed.xml')!;
    const dailyFeed = db.feeds.find((f) => f.url === 'https://daily.example.com/feed.xml')!;
    expect(offFeed.last_status).toBe('never');
    expect(dailyFeed.last_status).toBe('ok');
  });
});

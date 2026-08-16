import type { Env, RequestData } from '../../_lib/env';
import type { Feed, FeedCadence, FeedInput } from '../../../shared/types';
import { requireUserId } from '../../_lib/auth';
import { badRequestCode, json } from '../../_lib/http';
import { newId, nowIso } from '../../_lib/ids';
import { ensureTags } from '../../_lib/db';
import { parseUrl, hostOf } from '../../_lib/urlkey';
import { isBlockedHost } from '../../_lib/ssrf';
import { mapFeedRow } from '../../_lib/feed';
import { FEED_CADENCES } from '../../../shared/types';

function normalizeCadence(value: unknown): FeedCadence {
  return (FEED_CADENCES as string[]).includes(value as string) ? (value as FeedCadence) : 'off';
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((x) => typeof x === 'string')
        .map((x) => (x as string).trim())
        .filter((x) => x.length > 0 && x.length <= 60),
    ),
  ];
}

/** GET /api/feeds — the user's subscriptions, newest first. */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const rows = await ctx.env.DB.prepare(
    `SELECT id, user_id, title, url, tag_names, cadence, last_fetched_at, last_status, created_at, updated_at
       FROM feeds WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all<{
      id: string;
      user_id: string;
      title: string;
      url: string;
      tag_names: string;
      cadence: string;
      last_fetched_at: string | null;
      last_status: string | null;
      created_at: string;
      updated_at: string;
    }>();
  return json<Feed[]>(rows.results.map(mapFeedRow));
};

/** POST /api/feeds — subscribe to an RSS/Atom URL. */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  let body: Partial<FeedInput>;
  try {
    body = await ctx.request.json();
  } catch {
    throw badRequestCode('feed_invalid_body', '请求体必须是 JSON 对象');
  }

  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  const parsed = parseUrl(rawUrl);
  if (!parsed) throw badRequestCode('feed_invalid_url', '请提供合法的 http(s) 订阅源地址');

  const url = parsed.toString();
  if (isBlockedHost(parsed.hostname)) {
    throw badRequestCode('feed_blocked_host', '该地址不可订阅（内网 / 保留地址）');
  }

  const tagNames = normalizeTags(body.tagNames);
  if (tagNames.length > 0) {
    await ensureTags(ctx.env, userId, tagNames);
  }

  const title =
    typeof body.title === 'string' && body.title.trim().length > 0
      ? body.title.trim().slice(0, 200)
      : (hostOf(url) ?? url).slice(0, 200);
  const cadence = normalizeCadence(body.cadence);
  const id = newId();
  const ts = nowIso();

  await ctx.env.DB.prepare(
    `INSERT INTO feeds (id, user_id, title, url, tag_names, cadence, last_fetched_at, last_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(id, userId, title, url, JSON.stringify(tagNames), cadence, 'never', ts, ts)
    .run();

  const feed: Feed = {
    id,
    userId,
    title,
    url,
    tagNames,
    cadence,
    lastFetchedAt: null,
    lastStatus: 'never',
    createdAt: ts,
    updatedAt: ts,
  };
  return json<Feed>(feed, { status: 201 });
};

import type { Env, RequestData } from '../../../_lib/env';
import type { FeedRefreshResult } from '../../../../shared/types';
import { requireUserId } from '../../../_lib/auth';
import { json, notFound } from '../../../_lib/http';
import { refreshFeed } from '../../../_lib/feed';

/** POST /api/feeds/:id/refresh — pull the feed once and create new bookmarks. */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const feedId = ctx.params.id;

  const row = await ctx.env.DB.prepare(
    `SELECT id, user_id, url, tag_names FROM feeds WHERE id = ? AND user_id = ?`,
  )
    .bind(feedId, userId)
    .first<{ id: string; user_id: string; url: string; tag_names: string }>();

  if (!row) throw notFound('订阅源不存在');

  let tagNames: string[] = [];
  try {
    const v = JSON.parse(row.tag_names);
    if (Array.isArray(v)) tagNames = v.filter((x) => typeof x === 'string');
  } catch {
    tagNames = [];
  }

  const outcome = await refreshFeed(ctx.env, userId, { id: row.id, url: row.url, tagNames });

  const result: FeedRefreshResult = { feedId: row.id, ...outcome };
  return json<FeedRefreshResult>(result, { status: 200 });
};

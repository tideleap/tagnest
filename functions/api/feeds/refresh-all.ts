import type { Env, RequestData } from '../../_lib/env';
import type { FeedCadence, FeedRefreshResult } from '../../../shared/types';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import { refreshFeed } from '../../_lib/feed';

const CADENCE_WINDOW_MS: Record<Exclude<FeedCadence, 'off'>, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** A feed is "due" when it has never been fetched or its last fetch is older
 *  than the window implied by its cadence. */
function isDue(cadence: string, lastFetchedAt: string | null): boolean {
  if (cadence === 'off') return false;
  const window = CADENCE_WINDOW_MS[cadence as Exclude<FeedCadence, 'off'>];
  if (window === undefined) return false;
  if (!lastFetchedAt) return true;
  const ms = Date.parse(lastFetchedAt);
  if (Number.isNaN(ms)) return true;
  return Date.now() - ms >= window;
}

/**
 * POST /api/feeds/refresh-all — refresh every feed whose cadence window has
 * elapsed. This is the trigger the UI's "刷新全部" button hits (and the natural
 * hook for a future cron). One feed failing never aborts the rest.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  const rows = await ctx.env.DB.prepare(
    `SELECT id, user_id, url, tag_names, cadence, last_fetched_at
       FROM feeds WHERE user_id = ? AND cadence <> 'off'`,
  )
    .bind(userId)
    .all<{
      id: string;
      user_id: string;
      url: string;
      tag_names: string;
      cadence: string;
      last_fetched_at: string | null;
    }>();

  const results: FeedRefreshResult[] = [];
  for (const row of rows.results) {
    if (!isDue(row.cadence, row.last_fetched_at)) continue;

    let tagNames: string[] = [];
    try {
      const v = JSON.parse(row.tag_names);
      if (Array.isArray(v)) tagNames = v.filter((x) => typeof x === 'string');
    } catch {
      tagNames = [];
    }

    try {
      const outcome = await refreshFeed(ctx.env, userId, { id: row.id, url: row.url, tagNames });
      results.push({ feedId: row.id, ...outcome });
    } catch {
      // refreshFeed already recorded the failure status on the feed row.
      results.push({ feedId: row.id, added: 0, skipped: 0, failed: 0 });
    }
  }

  const added = results.reduce((n, r) => n + r.added, 0);
  return json({ results, refreshed: results.length, added }, { status: 200 });
};

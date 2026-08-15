import type { TagMergeLogEntry } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';

/**
 * Merge audit trail: the most recent 50 merges, newest first.
 *
 * Rows are self-contained snapshots (names, not just ids), so the history
 * stays readable even after the merged-away tags are gone.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const result = await ctx.env.DB.prepare(
    `SELECT id, target_tag_id, target_tag_name, source_tag_names, merged_count, created_at
       FROM tag_merge_log
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();

  const entries: TagMergeLogEntry[] = result.results.map((row) => ({
    id: String(row.id),
    targetTagId: String(row.target_tag_id),
    targetTagName: String(row.target_tag_name),
    sourceTagNames: parseNames(row.source_tag_names),
    mergedCount: Number(row.merged_count),
    createdAt: String(row.created_at),
  }));

  return json(entries);
};

function parseNames(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

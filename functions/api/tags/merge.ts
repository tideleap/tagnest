import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, notFound, readJson } from '../../_lib/http';
import { newId, nowIso } from '../../_lib/ids';

/**
 * Folds one or more tags into a target.
 *
 * Cleaning up an import that produced "js", "JS" and "javascript" is the
 * common case, and doing it by hand means re-tagging every affected bookmark.
 *
 * Two input shapes:
 *   - single:  `{ sourceIds, targetId }` — one merge
 *   - batch:   `{ clusters: [{ sourceIds, targetId }, ...] }` — up to 20 merges
 *     in one request, so the governance panel's "merge all" is a single
 *     round-trip instead of N serial calls (no partial-failure window, one
 *     cache invalidation).
 *
 * Every executed merge writes one row to `tag_merge_log`. Source tags are
 * deleted by the merge, so the log snapshots names — an audit trail full of
 * dangling ids would be useless.
 */

interface MergeCluster {
  sourceIds: string[];
  targetId: string;
}

const MAX_CLUSTERS = 20;
const MAX_SOURCES = 50;

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{
    sourceIds?: unknown;
    targetId?: unknown;
    clusters?: unknown;
  }>(ctx.request);

  // Normalise both shapes into a cluster list.
  let clusters: MergeCluster[];
  if (Array.isArray(body.clusters)) {
    clusters = body.clusters
      .filter((c): c is { sourceIds?: unknown; targetId?: unknown } => !!c && typeof c === 'object')
      .slice(0, MAX_CLUSTERS)
      .map((c) => ({
        targetId: String(c.targetId ?? ''),
        sourceIds: Array.isArray(c.sourceIds) ? c.sourceIds.map(String) : [],
      }));
  } else {
    clusters = [
      {
        targetId: String(body.targetId ?? ''),
        sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : [],
      },
    ];
  }

  clusters = clusters
    .map((c) => ({
      targetId: c.targetId,
      sourceIds: [...new Set(c.sourceIds)].filter((id) => id && id !== c.targetId).slice(0, MAX_SOURCES),
    }))
    .filter((c) => c.targetId && c.sourceIds.length > 0);

  if (clusters.length === 0) throw badRequest('请选择要合并的标签');

  // Ownership check for every target up front; a batch touching someone
  // else's tag fails whole rather than half-executing.
  const targetIds = [...new Set(clusters.map((c) => c.targetId))];
  const tph = targetIds.map(() => '?').join(',');
  const targets = await ctx.env.DB.prepare(
    `SELECT id, name FROM tags WHERE user_id = ? AND id IN (${tph})`,
  )
    .bind(userId, ...targetIds)
    .all<{ id: string; name: string }>();
  const targetById = new Map(targets.results.map((t) => [t.id, t.name]));
  if (targetById.size !== targetIds.length) throw notFound('目标标签不存在');

  // Snapshot source names before the merge deletes them (audit trail).
  const allSourceIds = [...new Set(clusters.flatMap((c) => c.sourceIds))];
  const sph = allSourceIds.map(() => '?').join(',');
  const sources = await ctx.env.DB.prepare(
    `SELECT id, name FROM tags WHERE user_id = ? AND id IN (${sph})`,
  )
    .bind(userId, ...allSourceIds)
    .all<{ id: string; name: string }>();
  const sourceNameById = new Map(sources.results.map((s) => [s.id, s.name]));

  const statements = [];
  const logIds: string[] = [];
  let merged = 0;

  for (const cluster of clusters) {
    // Drop sources this user does not own (already filtered above for targets;
    // a source id belonging to another user simply matches nothing here).
    const sourceIds = cluster.sourceIds.filter((id) => sourceNameById.has(id));
    if (sourceIds.length === 0) continue;

    const ph = sourceIds.map(() => '?').join(',');

    // Repoint every link, ignoring rows that would collide with an existing
    // (bookmark, target) pair.
    statements.push(
      ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id)
         SELECT bt.bookmark_id, ?
           FROM bookmark_tags bt
           JOIN tags t ON t.id = bt.tag_id
          WHERE t.user_id = ? AND bt.tag_id IN (${ph})`,
      ).bind(cluster.targetId, userId, ...sourceIds),
    );

    // Cascade on tags removes the leftover source links.
    statements.push(
      ctx.env.DB.prepare(`DELETE FROM tags WHERE user_id = ? AND id IN (${ph})`).bind(
        userId,
        ...sourceIds,
      ),
    );

    // Audit row: names are snapshotted because the source tags are about to
    // stop existing.
    const logId = newId();
    logIds.push(logId);
    statements.push(
      ctx.env.DB.prepare(
        `INSERT INTO tag_merge_log (id, user_id, target_tag_id, target_tag_name, source_tag_names, merged_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        logId,
        userId,
        cluster.targetId,
        String(targetById.get(cluster.targetId)),
        JSON.stringify(sourceIds.map((id) => sourceNameById.get(id))),
        sourceIds.length,
        nowIso(),
      ),
    );

    merged += sourceIds.length;
  }

  if (statements.length === 0) throw badRequest('请选择要合并的标签');
  await ctx.env.DB.batch(statements);

  return json({ merged, clusters: clusters.length, logIds });
};

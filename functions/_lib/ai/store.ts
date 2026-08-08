import type { Env } from '../env';
import { ensureTags } from '../db';
import { newId, nowIso } from '../ids';
import type { SuggestionResult } from './engine';

/**
 * Persistence for the AI tagging workflow: job progress and pending suggestions.
 *
 * ## Why jobs are snapshotted
 *
 * A run stores the exact list of bookmark IDs it will process into
 * `ai_jobs.scope` at creation time, rather than re-running a query per page.
 * Offset paging over a live "untagged" query is quietly wrong: accepting a
 * suggestion removes that bookmark from the set, every later page shifts, and
 * bookmarks get skipped. A snapshot also makes the run resumable — closing the
 * tab and coming back continues from `processed` instead of starting over.
 *
 * ## Why suggestions are rows, not a response body
 *
 * Proposals outlive the request that produced them. The user can organise 500
 * bookmarks now and review them tomorrow, on another device.
 */

/** Snapshot ceiling. Above this the UI asks the user to narrow the scope. */
export const MAX_JOB_ITEMS = 2000;

/** Bookmarks processed per `run` call. Sized to stay well inside request limits. */
export const RUN_CHUNK = 20;

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobScope {
  target: 'untagged' | 'all' | 'ids';
  /** Snapshot of bookmark IDs, in processing order. */
  ids: string[];
}

export interface JobRow {
  id: string;
  kind: string;
  status: JobStatus;
  total: number;
  processed: number;
  suggested: number;
  failed: number;
  engine: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  scope: JobScope | null;
}

function mapJob(row: Record<string, unknown>): JobRow {
  let scope: JobScope | null = null;
  try {
    scope = row.scope ? (JSON.parse(String(row.scope)) as JobScope) : null;
  } catch {
    scope = null;
  }

  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status) as JobStatus,
    total: Number(row.total ?? 0),
    processed: Number(row.processed ?? 0),
    suggested: Number(row.suggested ?? 0),
    failed: Number(row.failed ?? 0),
    engine: (row.engine as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    scope,
  };
}

/* ------------------------------------------------------------------ *
 * Scope resolution
 * ------------------------------------------------------------------ */

/**
 * Resolves a requested scope into a concrete, ordered list of bookmark IDs.
 *
 * `untagged` is the default entry point because it is the one that pays off
 * immediately: it targets exactly the bookmarks the library cannot currently
 * surface by topic.
 */
export async function resolveScope(
  env: Env,
  userId: string,
  target: JobScope['target'],
  explicitIds: string[] = [],
): Promise<string[]> {
  if (target === 'ids') {
    if (explicitIds.length === 0) return [];
    const placeholders = explicitIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id FROM bookmarks
        WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
        ORDER BY created_at DESC`,
    )
      .bind(userId, ...explicitIds)
      .all<{ id: string }>();
    return rows.results.map((r) => r.id);
  }

  const untaggedClause =
    target === 'untagged'
      ? `AND NOT EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id)`
      : '';

  const rows = await env.DB.prepare(
    `SELECT b.id AS id FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL ${untaggedClause}
      ORDER BY b.created_at DESC
      LIMIT ?`,
  )
    .bind(userId, MAX_JOB_ITEMS)
    .all<{ id: string }>();

  return rows.results.map((r) => r.id);
}

/** Loads the bookmark fields the engines need, preserving the requested order. */
export async function loadBookmarkInputs(
  env: Env,
  userId: string,
  ids: string[],
): Promise<Array<{ id: string; url: string; title: string; description: string | null }>> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, url, title, description FROM bookmarks
      WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
  )
    .bind(userId, ...ids)
    .all<Record<string, unknown>>();

  const byId = new Map(
    rows.results.map((row) => [
      String(row.id),
      {
        id: String(row.id),
        url: String(row.url),
        title: String(row.title ?? ''),
        description: (row.description as string | null) ?? null,
      },
    ]),
  );

  // Preserve caller order; silently drop anything deleted since the snapshot.
  return ids.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export async function createJob(
  env: Env,
  userId: string,
  kind: string,
  scope: JobScope,
): Promise<JobRow> {
  const id = newId();
  const ts = nowIso();

  await env.DB.prepare(
    `INSERT INTO ai_jobs (id, user_id, kind, status, scope, total, processed, suggested, failed, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, 0, 0, 0, ?, ?)`,
  )
    .bind(id, userId, kind, JSON.stringify(scope), scope.ids.length, ts, ts)
    .run();

  return {
    id,
    kind,
    status: 'queued',
    total: scope.ids.length,
    processed: 0,
    suggested: 0,
    failed: 0,
    engine: null,
    error: null,
    createdAt: ts,
    updatedAt: ts,
    scope,
  };
}

export async function getJob(env: Env, userId: string, jobId: string): Promise<JobRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM ai_jobs WHERE id = ? AND user_id = ? LIMIT 1`)
    .bind(jobId, userId)
    .first<Record<string, unknown>>();
  return row ? mapJob(row) : null;
}

export interface JobPatch {
  status?: JobStatus;
  processed?: number;
  suggested?: number;
  failed?: number;
  engine?: string | null;
  error?: string | null;
}

export async function updateJob(env: Env, userId: string, jobId: string, patch: JobPatch): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [nowIso()];

  const columns: Array<[keyof JobPatch, string]> = [
    ['status', 'status'],
    ['processed', 'processed'],
    ['suggested', 'suggested'],
    ['failed', 'failed'],
    ['engine', 'engine'],
    ['error', 'error'],
  ];

  for (const [key, column] of columns) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      params.push(patch[key]);
    }
  }

  // Scope the update to the owning user so the core layer is safe even if a
  // future caller forgets its own ownership check (defense in depth).
  params.push(userId, jobId);
  await env.DB.prepare(`UPDATE ai_jobs SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`)
    .bind(...params)
    .run();
}

/** Most recent jobs, for the "last run" summary in the UI. */
export async function listJobs(env: Env, userId: string, limit = 5): Promise<JobRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM ai_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<Record<string, unknown>>();
  return rows.results.map(mapJob);
}

/* ------------------------------------------------------------------ *
 * Suggestions
 * ------------------------------------------------------------------ */

/**
 * Replaces the pending suggestions for the given bookmarks.
 *
 * Delete-then-insert rather than upsert: re-running the organiser should
 * refresh proposals, not stack a second copy of each one for the user to
 * dismiss. Decided rows (accepted/rejected) are left untouched, so a rejection
 * is remembered rather than immediately re-proposed.
 */
export async function saveSuggestions(
  env: Env,
  userId: string,
  jobId: string | null,
  results: SuggestionResult[],
): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  const ts = nowIso();
  let written = 0;

  for (const result of results) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM tag_suggestions WHERE bookmark_id = ? AND user_id = ? AND status = 'pending'`,
      ).bind(result.bookmarkId, userId),
    );

    for (const tag of result.tags) {
      // A tag the bookmark already carries is not a suggestion.
      statements.push(
        env.DB.prepare(
          `INSERT INTO tag_suggestions
             (id, user_id, bookmark_id, job_id, tag_name, tag_id, confidence, source, reason, topic, needs_review, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
            WHERE NOT EXISTS (
              SELECT 1 FROM bookmark_tags bt
               WHERE bt.bookmark_id = ? AND bt.tag_id IS NOT NULL AND bt.tag_id = ?
            )
              AND NOT EXISTS (
              SELECT 1 FROM tag_suggestions s
               WHERE s.bookmark_id = ? AND s.tag_name = ? COLLATE NOCASE AND s.status = 'rejected'
            )`,
        ).bind(
          newId(),
          userId,
          result.bookmarkId,
          jobId,
          tag.name,
          tag.tagId,
          tag.confidence,
          tag.source,
          tag.reason,
          result.topic,
          result.needsReview ? 1 : 0,
          ts,
          result.bookmarkId,
          tag.tagId,
          result.bookmarkId,
          tag.name,
        ),
      );
      written += 1;
    }

    if (result.summary) {
      statements.push(
        env.DB.prepare(
          `UPDATE bookmarks SET ai_summary = ?
            WHERE id = ? AND user_id = ? AND (ai_summary IS NULL OR ai_summary = '')`,
        ).bind(result.summary, result.bookmarkId, userId),
      );
    }
  }

  if (statements.length > 0) {
    // D1 caps a single batch at 100 statements. A full chunk of 20 bookmarks
    // with 4 tags + delete + summary each can reach 120 statements, so split
    // into safe slices rather than letting D1 reject the whole chunk.
    const BATCH_STATEMENT_LIMIT = 100;
    for (let i = 0; i < statements.length; i += BATCH_STATEMENT_LIMIT) {
      await env.DB.batch(statements.slice(i, i + BATCH_STATEMENT_LIMIT));
    }
  }
  return written;
}

export interface SuggestionRow {
  id: string;
  bookmarkId: string;
  bookmarkTitle: string;
  bookmarkUrl: string;
  tagName: string;
  tagId: string | null;
  confidence: number;
  source: string;
  reason: string | null;
  /** Topic phrase for the bookmark, used for in-job clustering. */
  topic: string | null;
  /** Model flagged this proposal as needing a human sanity check. */
  needsReview: boolean;
  createdAt: string;
}

/** The review queue, joined to enough bookmark context to judge a suggestion. */
export async function listPendingSuggestions(
  env: Env,
  userId: string,
  limit = 200,
  jobId?: string | null,
): Promise<SuggestionRow[]> {
  const jobClause = jobId ? 'AND s.job_id = ?' : '';
  const params: unknown[] = jobId ? [userId, jobId, limit] : [userId, limit];

  const rows = await env.DB.prepare(
    `SELECT s.id, s.bookmark_id, s.tag_name, s.tag_id, s.confidence, s.source, s.reason,
            s.topic, s.needs_review, s.created_at, b.title AS bookmark_title, b.url AS bookmark_url
       FROM tag_suggestions s
       JOIN bookmarks b ON b.id = s.bookmark_id AND b.deleted_at IS NULL
      WHERE s.user_id = ? AND s.status = 'pending' ${jobClause}
      ORDER BY s.confidence DESC, s.created_at DESC
      LIMIT ?`,
  )
    .bind(...params)
    .all<Record<string, unknown>>();

  return rows.results.map((row) => ({
    id: String(row.id),
    bookmarkId: String(row.bookmark_id),
    bookmarkTitle: String(row.bookmark_title ?? ''),
    bookmarkUrl: String(row.bookmark_url ?? ''),
    tagName: String(row.tag_name),
    tagId: (row.tag_id as string | null) ?? null,
    confidence: Number(row.confidence ?? 0),
    source: String(row.source ?? 'model'),
    reason: (row.reason as string | null) ?? null,
    topic: (row.topic as string | null) ?? null,
    needsReview: Number(row.needs_review ?? 0) === 1,
    createdAt: String(row.created_at),
  }));
}

export interface ApplyOutcome {
  accepted: number;
  rejected: number;
  tagsCreated: number;
}

/**
 * Accepts or rejects suggestions.
 *
 * Accepted tags are written with `source = 'ai'` and their confidence, which is
 * what makes "undo everything the AI did" and the contribution stats possible.
 * The user's own tags are never touched.
 */
export async function decideSuggestions(
  env: Env,
  userId: string,
  ids: string[],
  action: 'accept' | 'reject',
): Promise<ApplyOutcome> {
  if (ids.length === 0) return { accepted: 0, rejected: 0, tagsCreated: 0 };

  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, bookmark_id, tag_name, tag_id, confidence
       FROM tag_suggestions
      WHERE user_id = ? AND status = 'pending' AND id IN (${placeholders})`,
  )
    .bind(userId, ...ids)
    .all<Record<string, unknown>>();

  if (rows.results.length === 0) return { accepted: 0, rejected: 0, tagsCreated: 0 };

  const ts = nowIso();
  const foundIds = rows.results.map((r) => String(r.id));

  if (action === 'reject') {
    const marks = foundIds.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE tag_suggestions SET status = 'rejected', decided_at = ?
        WHERE user_id = ? AND id IN (${marks})`,
    )
      .bind(ts, userId, ...foundIds)
      .run();
    return { accepted: 0, rejected: foundIds.length, tagsCreated: 0 };
  }

  // Resolve every name in one pass so a batch accept is a couple of round
  // trips rather than one per tag.
  const names = [...new Set(rows.results.map((r) => String(r.tag_name)))];
  const { ids: tagIds, created } = await ensureTags(env, userId, names);

  const byLower = new Map<string, string>();
  names.forEach((name, index) => {
    if (tagIds[index]) byLower.set(name.toLowerCase(), tagIds[index]);
  });

  const statements: D1PreparedStatement[] = [];

  for (const row of rows.results) {
    const tagId = (row.tag_id as string | null) ?? byLower.get(String(row.tag_name).toLowerCase());
    if (!tagId) continue;

    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, confidence, created_at)
         VALUES (?, ?, 'ai', ?, ?)`,
      ).bind(String(row.bookmark_id), tagId, Number(row.confidence ?? 0), ts),
    );
  }

  const marks = foundIds.map(() => '?').join(',');
  statements.push(
    env.DB.prepare(
      `UPDATE tag_suggestions SET status = 'accepted', decided_at = ?
        WHERE user_id = ? AND id IN (${marks})`,
    ).bind(ts, userId, ...foundIds),
  );

  await env.DB.batch(statements);
  return { accepted: foundIds.length, rejected: 0, tagsCreated: created };
}

/**
 * Applies high-confidence suggestions without review.
 *
 * Only reachable when the user has lowered `autoApplyThreshold` below 1, i.e.
 * has explicitly traded review for speed after seeing the quality.
 */
export async function autoApply(
  env: Env,
  userId: string,
  threshold: number,
  jobId: string,
): Promise<number> {
  if (threshold >= 1) return 0;

  const rows = await env.DB.prepare(
    `SELECT id FROM tag_suggestions
      WHERE user_id = ? AND job_id = ? AND status = 'pending' AND confidence >= ?`,
  )
    .bind(userId, jobId, threshold)
    .all<{ id: string }>();

  if (rows.results.length === 0) return 0;
  const outcome = await decideSuggestions(
    env,
    userId,
    rows.results.map((r) => r.id),
    'accept',
  );
  return outcome.accepted;
}

/** Counts pending proposals, for the nav badge. */
export async function countPending(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tag_suggestions s
       JOIN bookmarks b ON b.id = s.bookmark_id AND b.deleted_at IS NULL
      WHERE s.user_id = ? AND s.status = 'pending'`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

import type { Env } from '../env';
import { D1_MAX_PARAMS, ensureTags, PRIVATE_BOOKMARK_CLAUSE, queryInChunks } from '../db';
import { hostOf } from '../urlkey';
import { newId, nowIso } from '../ids';
import { recordFeedback, type FeedbackRecord } from './feedback';
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
  /** Prompt template revision that produced this run (Phase 5, for A/B). */
  promptVersion: string | null;
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
    promptVersion: (row.prompt_version as string | null) ?? null,
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
      `SELECT id FROM bookmarks b
        WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE} AND b.id IN (${placeholders})
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
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE} ${untaggedClause}
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
      `SELECT id, url, title, description FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE} AND b.id IN (${placeholders})`,
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

/**
 * Loads a handful of the user's own well-tagged bookmarks to serve as
 * few-shot examples (方案B).
 *
 * "Well-tagged" = carries at least two tags, so the example demonstrates the
 * multi-tag granularity we want the model to reproduce. Using the user's own
 * library instead of a canned example set teaches the model their personal
 * naming, granularity and domain mix — which is exactly the signal a static
 * example cannot carry.
 *
 * Returns plain rows; the caller shapes them into prompt `Example`s.
 */
export async function loadFewShotExamples(
  env: Env,
  userId: string,
  limit = 4,
): Promise<
  Array<{
    title: string;
    url: string;
    description: string | null;
    tags: string[];
  }>
> {
  // Bookmarks with >= 2 tags, most recently updated first.
  const rows = await env.DB.prepare(
    `SELECT b.id AS id, b.url AS url, b.title AS title, b.description AS description
       FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
        AND (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.bookmark_id = b.id) >= 2
      ORDER BY b.updated_at DESC
      LIMIT ?`,
  )
    .bind(userId, limit)
    .all<Record<string, unknown>>();

  if (rows.results.length === 0) return [];

  const ids = rows.results.map((r) => String(r.id));
  const placeholders = ids.map(() => '?').join(',');
  const tagRows = await env.DB.prepare(
    `SELECT bt.bookmark_id AS bookmark_id, t.name AS name
       FROM bookmark_tags bt
       JOIN tags t ON t.id = bt.tag_id
      WHERE bt.bookmark_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<Record<string, unknown>>();

  const tagsByBookmark = new Map<string, string[]>();
  for (const row of tagRows.results) {
    const list = tagsByBookmark.get(String(row.bookmark_id)) ?? [];
    list.push(String(row.name));
    tagsByBookmark.set(String(row.bookmark_id), list);
  }

  return rows.results
    .map((row) => ({
      title: String(row.title ?? ''),
      url: String(row.url),
      description: (row.description as string | null) ?? null,
      tags: tagsByBookmark.get(String(row.id)) ?? [],
    }))
    .filter((row) => row.tags.length >= 2 && row.title.trim().length > 0);
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export async function createJob(
  env: Env,
  userId: string,
  kind: string,
  scope: JobScope,
  promptVersion?: string | null,
): Promise<JobRow> {
  const id = newId();
  const ts = nowIso();

  await env.DB.prepare(
    `INSERT INTO ai_jobs (id, user_id, kind, status, scope, total, processed, suggested, failed, created_at, updated_at, prompt_version)
     VALUES (?, ?, ?, 'queued', ?, ?, 0, 0, 0, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      kind,
      JSON.stringify(scope),
      scope.ids.length,
      ts,
      ts,
      promptVersion ?? null,
    )
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
    promptVersion: promptVersion ?? null,
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
             (id, user_id, bookmark_id, job_id, tag_name, tag_id, confidence, source, reason, topic, needs_review, feedback_boosted, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
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
          tag.feedbackBoosted ? 1 : 0,
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
  /** Confidence was lifted by the user's feedback history (see feedbackBoost). */
  feedbackBoosted: boolean;
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
            s.topic, s.needs_review, s.feedback_boosted, s.created_at, b.title AS bookmark_title, b.url AS bookmark_url
       FROM tag_suggestions s
       JOIN bookmarks b ON b.id = s.bookmark_id AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
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
    feedbackBoosted: Number(row.feedback_boosted ?? 0) === 1,
    createdAt: String(row.created_at),
  }));
}

export interface ApplyOutcome {
  accepted: number;
  rejected: number;
  tagsCreated: number;
}

/**
 * Flips decided suggestions to `status` in chunks of 97 ids, keeping each
 * UPDATE within D1's 100 bound-parameter cap (3 fixed params + 97 ids).
 */
async function markDecided(
  env: Env,
  userId: string,
  ids: string[],
  status: 'accepted' | 'rejected',
  ts: string,
): Promise<void> {
  const CHUNK = D1_MAX_PARAMS - 3;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const marks = slice.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE tag_suggestions SET status = ?, decided_at = ?
        WHERE user_id = ? AND id IN (${marks})`,
    )
      .bind(status, ts, userId, ...slice)
      .run();
  }
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
  opts?: { renameTo?: string } | null,
): Promise<ApplyOutcome> {
  if (ids.length === 0) return { accepted: 0, rejected: 0, tagsCreated: 0 };

  // A bulk decision can carry up to MAX_DECISIONS (500) ids; binding them all
  // into one IN(...) would blow D1's 100-param cap, so fetch in chunks.
  const rows = await queryInChunks<Record<string, unknown>, Record<string, unknown>>(
    env.DB,
    ids,
    [userId],
    (ph) =>
      `SELECT s.id, s.bookmark_id, s.tag_name, s.tag_id, s.confidence, s.source,
              b.url AS bookmark_url, b.title AS bookmark_title
         FROM tag_suggestions s
         JOIN bookmarks b ON b.id = s.bookmark_id AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
        WHERE s.user_id = ? AND s.status = 'pending' AND s.id IN (${ph})`,
    (r) => r,
  );

  if (rows.length === 0) return { accepted: 0, rejected: 0, tagsCreated: 0 };

  const ts = nowIso();
  const foundIds = rows.map((r) => String(r.id));

  // The feedback event for every decided suggestion. Computed once and shared
  // by both branches so the accept/reject loop is recorded consistently.
  const feedback: FeedbackRecord[] = rows.map((r) => {
    const url = String(r.bookmark_url ?? '');
    const domain = hostOf(url);
    const context = `${String(r.bookmark_title ?? '')} · ${domain ?? ''}`.trim();
    return {
      bookmarkId: String(r.bookmark_id),
      tagName: String(r.tag_name),
      action: action === 'reject' ? 'rejected' : 'accepted',
      source: (r.source as string | null) ?? null,
      confidence: Number(r.confidence ?? 0),
      domain,
      context,
    };
  });

  if (action === 'reject') {
    await markDecided(env, userId, foundIds, 'rejected', ts);
    await recordFeedback(env, userId, feedback);
    return { accepted: 0, rejected: foundIds.length, tagsCreated: 0 };
  }

  // "Edit before accept": when a single suggestion is renamed, accept it under
  // the new spelling and record a 'modified' event so future runs prefer it.
  let renameTo: string | null = null;
  if (opts?.renameTo && ids.length === 1) {
    const trimmed = opts.renameTo.trim();
    if (trimmed) renameTo = trimmed;
  }

  // Resolve every name in one pass so a batch accept is a couple of round
  // trips rather than one per tag.
  const names = [...new Set(rows.map((r) => String(r.tag_name)))];
  if (renameTo) names.push(renameTo);
  const { ids: tagIds, created } = await ensureTags(env, userId, names);

  const byLower = new Map<string, string>();
  names.forEach((name, index) => {
    if (tagIds[index]) byLower.set(name.toLowerCase(), tagIds[index]);
  });

  // Rewrite the renamed suggestion's feedback as a 'modified' event (the old
  // spelling is rejected and mapped to the new) plus an 'accepted' event for
  // the new name so it earns a boost too.
  if (renameTo) {
    const target = rows[0];
    const idx = feedback.findIndex(
      (f) => f.bookmarkId === String(target.bookmark_id) && f.tagName === String(target.tag_name),
    );
    if (idx >= 0) {
      const { domain, context, source, confidence } = feedback[idx];
      feedback[idx] = {
        bookmarkId: String(target.bookmark_id),
        tagName: String(target.tag_name),
        action: 'modified',
        finalTagId: byLower.get(renameTo.toLowerCase()) ?? null,
        source,
        confidence,
        domain,
        context: renameTo,
      };
      feedback.push({
        bookmarkId: String(target.bookmark_id),
        tagName: renameTo,
        action: 'accepted',
        source: 'taxonomy',
        confidence: null,
        domain,
        context,
      });
    }
  }

  const statements: D1PreparedStatement[] = [];

  for (const row of rows) {
    const tagName = renameTo ? renameTo : String(row.tag_name);
    const tagId = byLower.get(tagName.toLowerCase()) ?? null;
    if (!tagId) continue;

    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, confidence, created_at)
         VALUES (?, ?, 'ai', ?, ?)`,
      ).bind(String(row.bookmark_id), tagId, Number(row.confidence ?? 0), ts),
    );
  }

  // Flush the tag links in groups of 90 so a large bulk accept — a whole run
  // can be 130+ writes — never trips D1's 100-statement batch cap.
  const BATCH_LIMIT = 90;
  for (let i = 0; i < statements.length; i += BATCH_LIMIT) {
    await env.DB.batch(statements.slice(i, i + BATCH_LIMIT));
  }

  // Flip the decided suggestions to 'accepted' after the inserts (chunked the
  // same way as the reject path). Doing it last means a partial insert failure
  // leaves the queue retryable (status stays 'pending') rather than half-applied.
  await markDecided(env, userId, foundIds, 'accepted', ts);

  await recordFeedback(env, userId, feedback);
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
       JOIN bookmarks b ON b.id = s.bookmark_id AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
      WHERE s.user_id = ? AND s.status = 'pending'`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * P2-2 — imbalance signal for an incremental run.
 *
 * Counts the DISTINCT new tags this job proposed (tag_id NULL = not resolved to
 * an existing tag) and the size of the user's pre-existing taxonomy. The caller
 * feeds both into `shouldWarnRebalance` to decide whether the run drifted far
 * enough to merit a "consider a full re-classify" hint.
 *
 * New tags are counted across all of the job's suggestions (not just pending),
 * because accepted ones are exactly the ones that will land in the taxonomy.
 */
export async function countJobNewTags(
  env: Env,
  userId: string,
  jobId: string,
): Promise<{ newTags: number; existingTags: number }> {
  const newRow = await env.DB.prepare(
    `SELECT COUNT(DISTINCT tag_name COLLATE NOCASE) AS n FROM tag_suggestions
      WHERE user_id = ? AND job_id = ? AND tag_id IS NULL`,
  )
    .bind(userId, jobId)
    .first<{ n: number }>();

  const existingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tags WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ n: number }>();

  return {
    newTags: Number(newRow?.n ?? 0),
    existingTags: Number(existingRow?.n ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Undo
 * ------------------------------------------------------------------ */

export interface UndoOutcome {
  /** AI-written bookmark↔tag links removed. */
  removedLinks: number;
  /** Accepted suggestions returned to the review queue. */
  restoredSuggestions: number;
  /** Accepted suggestions dropped because a newer pending proposal replaced them. */
  droppedSuggestions: number;
}

/**
 * Undoes everything one run wrote into the library (plan T2 "可撤销").
 *
 * This is only possible because of migration 0006's provenance columns:
 * accepted suggestions keep their `job_id`, and the tag links they produced
 * carry `source = 'ai'`. Undo is three set-based statements — no per-row
 * loops, so a 2,000-bookmark run undoes in a handful of round trips:
 *
 *  1. Delete the `source = 'ai'` links whose (bookmark, tag name) pair traces
 *     back to an ACCEPTED suggestion of this job. The match goes by tag NAME
 *     (not the suggestion's `tag_id`) because a tag proposed as new has
 *     `tag_id = NULL` until accept resolves it.
 *  2. Flip the job's accepted suggestions back to `pending` so the user can
 *     decide again — unless a newer run already re-proposed the same
 *     (bookmark, tag), in which case
 *  3. …those stale accepted rows are dropped: the fresh pending proposal
 *     already represents them, and reviving them would violate the
 *     one-pending-per-(bookmark, tag) unique index.
 *
 * Known limitation: a suggestion accepted under a RENAMED spelling stores the
 * old name, so undo will not find the link the rename produced. That path is
 * single-suggestion-only and rare; the link remains manually removable.
 *
 * User-applied tags are never touched — `source = 'ai'` is the whole basis of
 * the delete, which is exactly why the column exists.
 */
export async function undoJob(
  env: Env,
  userId: string,
  jobId: string,
): Promise<UndoOutcome> {
  const delLinks = await env.DB.prepare(
    `DELETE FROM bookmark_tags
      WHERE source = 'ai'
        AND EXISTS (
          SELECT 1 FROM tag_suggestions s
           WHERE s.user_id = ? AND s.job_id = ? AND s.status = 'accepted'
             AND s.bookmark_id = bookmark_tags.bookmark_id
             AND EXISTS (
               SELECT 1 FROM tags t
                WHERE t.id = bookmark_tags.tag_id
                  AND t.user_id = ?
                  AND t.name = s.tag_name COLLATE NOCASE
             )
        )`,
  )
    .bind(userId, jobId, userId)
    .run();

  const restore = await env.DB.prepare(
    `UPDATE tag_suggestions SET status = 'pending', decided_at = NULL
      WHERE user_id = ? AND job_id = ? AND status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM tag_suggestions s2
           WHERE s2.bookmark_id = tag_suggestions.bookmark_id
             AND s2.tag_name = tag_suggestions.tag_name COLLATE NOCASE
             AND s2.status = 'pending'
             AND s2.id <> tag_suggestions.id
        )`,
  )
    .bind(userId, jobId)
    .run();

  const drop = await env.DB.prepare(
    `DELETE FROM tag_suggestions
      WHERE user_id = ? AND job_id = ? AND status = 'accepted'
        AND EXISTS (
          SELECT 1 FROM tag_suggestions s2
           WHERE s2.bookmark_id = tag_suggestions.bookmark_id
             AND s2.tag_name = tag_suggestions.tag_name COLLATE NOCASE
             AND s2.status = 'pending'
             AND s2.id <> tag_suggestions.id
        )`,
  )
    .bind(userId, jobId)
    .run();

  return {
    removedLinks: Number((delLinks.meta as { changes?: number } | undefined)?.changes ?? 0),
    restoredSuggestions: Number((restore.meta as { changes?: number } | undefined)?.changes ?? 0),
    droppedSuggestions: Number((drop.meta as { changes?: number } | undefined)?.changes ?? 0),
  };
}

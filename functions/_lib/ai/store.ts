import type { Env } from '../env';
import type { CategoryTreeNode, CategoryWritebackPage } from '../../../shared/types';
import { colorForName, D1_IN_CHUNK, D1_MAX_PARAMS, ensureTags, PRIVATE_BOOKMARK_CLAUSE, promotePendingTags, queryInChunks, withD1Retry } from '../db';
import { hostOf } from '../urlkey';
import { newId, nowIso } from '../ids';
import { recordFeedback, type FeedbackRecord } from './feedback';
import type { CategorizeResult, RenameResult, SuggestionResult } from './engine';

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

export type JobStatus = 'queued' | 'running' | 'finalizing' | 'done' | 'failed' | 'cancelled';

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
  // 并发分片下 D1 偶发 SQLITE_BUSY / 连接器重置 → 透明重试（withD1Retry 仅重试
  // 瞬时错误，且 UPDATE 幂等，重试安全）。
  await withD1Retry(() =>
    env.DB.prepare(`UPDATE ai_jobs SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`)
      .bind(...params)
      .run(),
  );
}

/**
 * Atomically advances a job's counters by a delta rather than overwriting them.
 *
 * The parallel-partition run path launches N concurrent `/run` calls, each
 * owning a disjoint slice of bookmark IDs. A naive read-modify-write
 * (`processed = job.processed + slice.length` from a per-request snapshot)
 * would drop every other partition's progress the moment two of them finish
 * at the same time. A single `UPDATE ... SET processed = processed + ?` is a
 * race-free increment no matter how many partitions land on it concurrently,
 * and it is what lets the final partition reliably detect "I am the last one"
 * by checking `processed >= total` after its own increment.
 */
export interface JobCounterPatch {
  processed?: number;
  suggested?: number;
  failed?: number;
  status?: JobStatus;
  error?: string | null;
}

export async function incrementJobCounters(
  env: Env,
  userId: string,
  jobId: string,
  patch: JobCounterPatch,
): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [nowIso()];

  const increment = (key: 'processed' | 'suggested' | 'failed') => {
    const delta = patch[key];
    if (delta && delta > 0) {
      sets.push(`${key} = ${key} + ?`);
      params.push(delta);
    }
  };
  increment('processed');
  increment('suggested');
  increment('failed');

  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    params.push(patch.error);
  }

  // Scope the update to the owning user (defense in depth).
  params.push(userId, jobId);
  // 并发分片下 D1 偶发 SQLITE_BUSY / 连接器重置 → 透明重试（withD1Retry 仅重试
  // 瞬时错误，且 UPDATE 幂等，重试安全）。
  await withD1Retry(() =>
    env.DB.prepare(`UPDATE ai_jobs SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`)
      .bind(...params)
      .run(),
  );
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
        `DELETE FROM tag_suggestions WHERE bookmark_id = ? AND user_id = ? AND kind = 'tag' AND status = 'pending'`,
      ).bind(result.bookmarkId, userId),
    );

    for (const tag of result.tags) {
      // A tag the bookmark already carries is not a suggestion.
      statements.push(
        env.DB.prepare(
          `INSERT INTO tag_suggestions
             (id, user_id, bookmark_id, job_id, tag_name, tag_id, confidence, source, reason, topic, needs_review, feedback_boosted, kind, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tag', 'pending', ?
            WHERE NOT EXISTS (
              SELECT 1 FROM bookmark_tags bt
               WHERE bt.bookmark_id = ? AND bt.tag_id IS NOT NULL AND bt.tag_id = ?
            )
              AND NOT EXISTS (
              SELECT 1 FROM tag_suggestions s
               WHERE s.bookmark_id = ? AND s.kind = 'tag' AND s.tag_name = ? COLLATE NOCASE AND s.status = 'rejected'
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
      // D1 并发写入偶发 SQLITE_BUSY / 连接器重置：批次整体原子回滚，重试安全。
      await withD1Retry(() => env.DB.batch(statements.slice(i, i + BATCH_STATEMENT_LIMIT)));
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
  /**
   * CategorySync (migration 0024): 'tag' rows propose a loose label; 'category'
   * rows propose a single primary placement whose `tagName` is the full path.
   * Rename mode (Phase B) adds 'rename' rows: `tagName` is the NEW title,
   * `topic` carries the ORIGINAL title it would replace (the undo basis).
   */
  kind: 'tag' | 'category' | 'rename';
  createdAt: string;
}

/** The review queue, joined to enough bookmark context to judge a suggestion. */
export async function listPendingSuggestions(
  env: Env,
  userId: string,
  limit = 200,
  jobId?: string | null,
  kind?: 'tag' | 'category' | 'rename' | null,
): Promise<SuggestionRow[]> {
  const jobClause = jobId ? 'AND s.job_id = ?' : '';
  const kindClause = kind ? 'AND s.kind = ?' : '';
  const params: unknown[] = [userId];
  if (jobId) params.push(jobId);
  if (kind) params.push(kind);
  params.push(limit);

  const rows = await env.DB.prepare(
    `SELECT s.id, s.bookmark_id, s.tag_name, s.tag_id, s.confidence, s.source, s.reason,
            s.topic, s.needs_review, s.feedback_boosted, s.kind, s.created_at, b.title AS bookmark_title, b.url AS bookmark_url
       FROM tag_suggestions s
       JOIN bookmarks b ON b.id = s.bookmark_id AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
      WHERE s.user_id = ? AND s.status = 'pending' ${jobClause} ${kindClause}
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
    kind:
      String(row.kind ?? 'tag') === 'category'
        ? 'category'
        : String(row.kind ?? 'tag') === 'rename'
          ? 'rename'
          : 'tag',
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
        WHERE s.user_id = ? AND s.status = 'pending' AND s.kind = 'tag' AND s.id IN (${ph})`,
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
  //
  // P2-3: tags minted by an AI accept start 'pending' — they only become
  // first-class once a second live bookmark adopts them (promoted below). Tags
  // the user already owns are never re-graded (ensureTags only marks rows it
  // created in this call).
  const names = [...new Set(rows.map((r) => String(r.tag_name)))];
  if (renameTo) names.push(renameTo);
  const { ids: tagIds, created } = await ensureTags(env, userId, names, { status: 'pending' });

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

  // P2-3 pending promotion: now that this accept's links are written, any
  // pending tag whose live support reached 2 becomes first-class. Runs on every
  // accept (not just ones that minted tags) because a tag created by an earlier
  // single-save may earn its second bookmark here. Best-effort: a promotion
  // hiccup must never fail the accept itself.
  try {
    await promotePendingTags(env, userId);
  } catch {
    /* promotion is best-effort; the accept already succeeded */
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
 *
 * `needs_review = 0` is enforced regardless of threshold: flagged rows (e.g.
 * quarantined adult content) are semantically "a human must look at this" and
 * must never slip through auto-apply even at a very low threshold.
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
      WHERE user_id = ? AND job_id = ? AND kind = 'tag' AND status = 'pending' AND needs_review = 0 AND confidence >= ?`,
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
      WHERE user_id = ? AND job_id = ? AND kind = 'tag' AND status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM tag_suggestions s2
           WHERE s2.bookmark_id = tag_suggestions.bookmark_id
             AND s2.kind = 'tag'
             AND s2.tag_name = tag_suggestions.tag_name COLLATE NOCASE
             AND s2.status = 'pending'
             AND s2.id <> tag_suggestions.id
        )`,
  )
    .bind(userId, jobId)
    .run();

  const drop = await env.DB.prepare(
    `DELETE FROM tag_suggestions
      WHERE user_id = ? AND job_id = ? AND kind = 'tag' AND status = 'accepted'
        AND EXISTS (
          SELECT 1 FROM tag_suggestions s2
           WHERE s2.bookmark_id = tag_suggestions.bookmark_id
             AND s2.kind = 'tag'
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

/* ================================================================== *
 * CategorySync P1 — primary-category persistence (C1-3 / §4)
 *
 * The tagging queue stores loose labels; the categorize queue stores a single
 * placement per bookmark. Both live in `tag_suggestions` (migration 0024 added
 * the `kind` column), so the review UI stays unified — but a category row's
 * `tag_name` carries the full path ("开发技术 > 前端开发") and accepting it
 * writes `bookmark_primary_category` instead of `bookmark_tags`.
 * ================================================================== */

/**
 * Resolves the scope for a categorize job.
 *
 * Differs from `resolveScope` in one deliberate way (PRD §10-6): bookmarks that
 * already hold a `source = 'browser_folder'` placement are skipped by default,
 * because a human move inside the managed folder outranks the model (D5). The
 * caller passes `includeBrowserFolder = true` for the "重新整理全部" path.
 */
export async function resolveCategorizeScope(
  env: Env,
  userId: string,
  target: JobScope['target'],
  explicitIds: string[] = [],
  includeBrowserFolder = false,
): Promise<string[]> {
  const browserFolderClause = includeBrowserFolder
    ? ''
    : `AND NOT EXISTS (
         SELECT 1 FROM bookmark_primary_category bpc
          WHERE bpc.bookmark_id = b.id AND bpc.source = 'browser_folder'
       )`;

  if (target === 'ids') {
    if (explicitIds.length === 0) return [];
    const placeholders = explicitIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id FROM bookmarks b
        WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE} ${browserFolderClause}
          AND b.id IN (${placeholders})
        ORDER BY created_at DESC`,
    )
      .bind(userId, ...explicitIds)
      .all<{ id: string }>();
    return rows.results.map((r) => r.id);
  }

  // For categorize, `untagged` means "no primary category yet" — the closest
  // analogue to the tagging scope, expressed against the placement table.
  const uncategorizedClause =
    target === 'untagged'
      ? `AND NOT EXISTS (SELECT 1 FROM bookmark_primary_category bpc WHERE bpc.bookmark_id = b.id)`
      : '';

  const rows = await env.DB.prepare(
    `SELECT b.id AS id FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE} ${browserFolderClause} ${uncategorizedClause}
      ORDER BY b.created_at DESC
      LIMIT ?`,
  )
    .bind(userId, MAX_JOB_ITEMS)
    .all<{ id: string }>();

  return rows.results.map((r) => r.id);
}

/**
 * Replaces the pending CATEGORY suggestions for the given bookmarks.
 *
 * Mirrors `saveSuggestions` but scoped to `kind = 'category'`: the delete only
 * touches category rows (a tagging run must never wipe category proposals and
 * vice versa), and the insert writes the full path as `tag_name` with the
 * deepest resolved node as `tag_id`.
 */
export async function saveCategorySuggestions(
  env: Env,
  userId: string,
  jobId: string | null,
  results: CategorizeResult[],
): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  const ts = nowIso();
  let written = 0;

  for (const result of results) {
    const candidate = result.category;
    if (!candidate) continue;

    statements.push(
      env.DB.prepare(
        `DELETE FROM tag_suggestions
          WHERE bookmark_id = ? AND user_id = ? AND kind = 'category' AND status = 'pending'`,
      ).bind(result.bookmarkId, userId),
    );

    const pathName = candidate.path.join(' > ');
    statements.push(
      env.DB.prepare(
        `INSERT INTO tag_suggestions
           (id, user_id, bookmark_id, job_id, tag_name, tag_id, confidence, source, reason,
            topic, needs_review, feedback_boosted, kind, status, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'category', 'pending', ?
          WHERE NOT EXISTS (
            SELECT 1 FROM bookmark_primary_category bpc
             WHERE bpc.bookmark_id = ? AND bpc.tag_id IS NOT NULL AND bpc.tag_id = ?
          )
            AND NOT EXISTS (
            SELECT 1 FROM tag_suggestions s
             WHERE s.bookmark_id = ? AND s.kind = 'category'
               AND s.tag_name = ? COLLATE NOCASE AND s.status = 'rejected'
          )`,
      ).bind(
        newId(),
        userId,
        result.bookmarkId,
        jobId,
        pathName,
        candidate.tagId,
        candidate.confidence,
        candidate.source,
        candidate.reason,
        candidate.path[0] ?? null,
        candidate.needsReview ? 1 : 0,
        candidate.feedbackBoosted ? 1 : 0,
        ts,
        result.bookmarkId,
        candidate.tagId,
        result.bookmarkId,
        pathName,
      ),
    );
    written += 1;
  }

  if (statements.length > 0) {
    const BATCH_STATEMENT_LIMIT = 100;
    for (let i = 0; i < statements.length; i += BATCH_STATEMENT_LIMIT) {
      // D1 并发写入偶发 SQLITE_BUSY / 连接器重置：批次整体原子回滚，重试安全。
      await withD1Retry(() => env.DB.batch(statements.slice(i, i + BATCH_STATEMENT_LIMIT)));
    }
  }
  return written;
}

/**
 * Creates (or reuses) the tag nodes along a category path and wires their
 * `parent_id` chain, returning the deepest node's id.
 *
 * Reuse is case-insensitive per level, matching `ensureTags` semantics, but a
 * level only reuses a tag whose PARENT matches the previous level — otherwise
 * two unrelated "前端开发" nodes under different tops would collapse into one.
 * New nodes get a deterministic colour from their name.
 */
export async function ensureCategoryPath(
  env: Env,
  userId: string,
  path: string[],
): Promise<{ leafTagId: string; created: number }> {
  const cleaned = path
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter((p) => p.length > 0 && p.length <= 60);
  if (cleaned.length === 0) throw new Error('ensureCategoryPath: empty path');

  let parentId: string | null = null;
  let created = 0;
  let leafTagId = '';
  const ts = nowIso();

  for (const name of cleaned) {
    // Look for an existing node with this name under the current parent.
    const existing = parentId
      ? await env.DB.prepare(
          `SELECT id FROM tags
            WHERE user_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE LIMIT 1`,
        )
          .bind(userId, parentId, name)
          .first<{ id: string }>()
      : await env.DB.prepare(
          `SELECT id FROM tags
            WHERE user_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE LIMIT 1`,
        )
          .bind(userId, name)
          .first<{ id: string }>();

    if (existing) {
      leafTagId = existing.id;
    } else {
      leafTagId = newId();
      created += 1;
      await env.DB.prepare(
        `INSERT INTO tags (id, user_id, name, color_index, parent_id, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).bind(leafTagId, userId, name, colorForName(name), parentId, ts)
        .run();
    }
    parentId = leafTagId;
  }

  return { leafTagId, created };
}

export interface CategoryApplyOutcome {
  accepted: number;
  rejected: number;
  tagsCreated: number;
}

/**
 * Accepts or rejects CATEGORY suggestions.
 *
 * Accepting writes `bookmark_primary_category` (single placement, `source='ai'`)
 * and materialises the path's tag nodes; it does NOT touch `bookmark_tags`, so
 * auxiliary tags stay exactly as the user left them (D2). Every decision is
 * recorded as feedback keyed by the full path string (C1-6).
 */
export async function decideCategorySuggestions(
  env: Env,
  userId: string,
  ids: string[],
  action: 'accept' | 'reject',
): Promise<CategoryApplyOutcome> {
  if (ids.length === 0) return { accepted: 0, rejected: 0, tagsCreated: 0 };

  const rows = await queryInChunks<Record<string, unknown>, Record<string, unknown>>(
    env.DB,
    ids,
    [userId],
    (ph) =>
      `SELECT s.id, s.bookmark_id, s.tag_name, s.tag_id, s.confidence, s.source, s.job_id,
              b.url AS bookmark_url, b.title AS bookmark_title
         FROM tag_suggestions s
         JOIN bookmarks b ON b.id = s.bookmark_id AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
        WHERE s.user_id = ? AND s.status = 'pending' AND s.kind = 'category' AND s.id IN (${ph})`,
    (r) => r,
  );

  if (rows.length === 0) return { accepted: 0, rejected: 0, tagsCreated: 0 };

  const ts = nowIso();
  const foundIds = rows.map((r) => String(r.id));

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

  // Accept: materialise each path and write the single placement.
  let tagsCreated = 0;
  const statements: D1PreparedStatement[] = [];
  const placedBookmarkIds: string[] = [];

  for (const row of rows) {
    const path = String(row.tag_name)
      .split('>')
      .map((p) => p.trim())
      .filter(Boolean);
    if (path.length === 0) continue;

    const { leafTagId, created } = await ensureCategoryPath(env, userId, path);
    tagsCreated += created;
    placedBookmarkIds.push(String(row.bookmark_id));

    statements.push(
      env.DB.prepare(
        `INSERT INTO bookmark_primary_category
           (bookmark_id, tag_id, confidence, source, job_id, status, decided_at, updated_at)
         VALUES (?, ?, ?, 'ai', ?, 'accepted', ?, ?)
         ON CONFLICT (bookmark_id) DO UPDATE SET
           tag_id = excluded.tag_id,
           confidence = excluded.confidence,
           source = excluded.source,
           job_id = excluded.job_id,
           status = excluded.status,
           decided_at = excluded.decided_at,
           updated_at = excluded.updated_at`,
      ).bind(
        String(row.bookmark_id),
        leafTagId,
        Number(row.confidence ?? 0),
        row.job_id ?? null,
        ts,
        ts,
      ),
    );
  }

  const BATCH_LIMIT = 90;
  for (let i = 0; i < statements.length; i += BATCH_LIMIT) {
    await env.DB.batch(statements.slice(i, i + BATCH_LIMIT));
  }

  // Accepted placements are category changes too — bump updated_at so the
  // affected bookmarks flow into the sync-pull stream on other browsers (C5-2).
  await bumpBookmarksUpdatedAt(env, userId, placedBookmarkIds, ts);

  await markDecided(env, userId, foundIds, 'accepted', ts);
  await recordFeedback(env, userId, feedback);
  return { accepted: foundIds.length, rejected: 0, tagsCreated };
}

/**
 * Applies high-confidence category suggestions without review (C1-5 auto path).
 * Only reachable when the user has lowered `autoApplyThreshold` below 1.
 * Rows flagged `needs_review` (e.g. quarantined adult placements) are always
 * excluded — they require a human decision by definition.
 */
export async function autoApplyCategories(
  env: Env,
  userId: string,
  threshold: number,
  jobId: string,
): Promise<number> {
  if (threshold >= 1) return 0;

  const rows = await env.DB.prepare(
    `SELECT id FROM tag_suggestions
      WHERE user_id = ? AND job_id = ? AND kind = 'category' AND status = 'pending' AND needs_review = 0 AND confidence >= ?`,
  )
    .bind(userId, jobId, threshold)
    .all<{ id: string }>();

  if (rows.results.length === 0) return 0;
  const outcome = await decideCategorySuggestions(
    env,
    userId,
    rows.results.map((r) => r.id),
    'accept',
  );
  return outcome.accepted;
}

/* ------------------------------------------------------------------ *
 * Category tree + path derivation (C2-1 / C4-1)
 * ------------------------------------------------------------------ */

// The wire shape lives in shared/types.ts so the frontend and the extension
// consume one contract; re-exported here so existing imports keep working.
export type { CategoryTreeNode };

/**
 * Builds the category tree = the tag tree (D4), annotated with how many
 * bookmarks each node holds via `bookmark_primary_category`.
 *
 * `count` is the subtree total (a top-level category shows every bookmark
 * under it), `directCount` is placements on the node itself. Nodes with zero
 * bookmarks anywhere in their subtree are still returned — the tree is the
 * user's taxonomy, not just the populated parts — so the UI can show empty
 * folders and the writeback builder can mirror them.
 */
/**
 * Loads every tag (id, name, parent_id) for a user into an id→node map, ordered
 * by `sort_order, name` so downstream tree construction preserves display order.
 *
 * This is the single source of truth for the "fetch the whole tag tree once"
 * step that `loadCategoryTree`, `deriveCategoryPaths`, and
 * `loadCategoryWritebackPage` all previously inlined — centralising it removes
 * three near-identical `SELECT id, name, parent_id FROM tags WHERE user_id = ?`
 * blocks and keeps the tree shape in one place.
 */
async function loadTagNodes(
  env: Env,
  userId: string,
): Promise<Map<string, { id: string; name: string; parentId: string | null }>> {
  const tagRows = await env.DB.prepare(
    `SELECT id, name, parent_id FROM tags WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE`,
  )
    .bind(userId)
    .all<{ id: string; name: string; parent_id: string | null }>();

  const map = new Map<string, { id: string; name: string; parentId: string | null }>();
  for (const t of tagRows.results) {
    map.set(t.id, { id: t.id, name: t.name, parentId: t.parent_id });
  }
  return map;
}

/**
 * Walks `parent_id` upward from `tagId` (depth-bounded against a corrupt tree)
 * and returns the category path, root → leaf. Returns null when no node exists
 * or the node has no upward chain.
 *
 * Single source of truth for the in-memory parent walk that
 * `deriveCategoryPaths` and `loadCategoryWritebackPage` previously duplicated
 * verbatim.
 */
function deriveCategoryPathFromNodes(
  nodeById: Map<string, { id: string; name: string; parentId: string | null }>,
  tagId: string,
): string[] | null {
  const path: string[] = [];
  let cursorId: string | null = tagId;
  for (let depth = 0; cursorId !== null && depth < 8; depth += 1) {
    const node = nodeById.get(cursorId);
    if (!node) break;
    path.unshift(node.name);
    cursorId = node.parentId;
  }
  return path.length > 0 ? path : null;
}

export async function loadCategoryTree(
  env: Env,
  userId: string,
): Promise<CategoryTreeNode[]> {
  const nodeById = await loadTagNodes(env, userId);

  const countRows = await env.DB.prepare(
    `SELECT bpc.tag_id AS tag_id, COUNT(*) AS c
       FROM bookmark_primary_category bpc
       JOIN bookmarks b ON b.id = bpc.bookmark_id
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND bpc.status = 'accepted'
      GROUP BY bpc.tag_id`,
  )
    .bind(userId)
    .all<{ tag_id: string; c: number }>();

  const directCount = new Map<string, number>();
  for (const r of countRows.results) directCount.set(r.tag_id, Number(r.c));

  const nodes = new Map<string, CategoryTreeNode>();
  for (const [id, node] of nodeById) {
    nodes.set(id, {
      tagId: id,
      name: node.name,
      parentId: node.parentId,
      count: 0,
      directCount: directCount.get(id) ?? 0,
      children: [],
    });
  }

  const roots: CategoryTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Roll direct counts up so each node's `count` covers its whole subtree.
  const accumulate = (node: CategoryTreeNode): number => {
    let total = node.directCount;
    for (const child of node.children) total += accumulate(child);
    node.count = total;
    return total;
  };
  for (const root of roots) accumulate(root);

  return roots;
}

/**
 * Derives a bookmark's category path by walking `parent_id` upward from its
 * placement node (C4-1). Returns null when the bookmark has no accepted
 * placement. This is the single source of truth for `categoryPath` — it is
 * never stored, so the tree and the path can never disagree.
 */
export async function deriveCategoryPath(
  env: Env,
  userId: string,
  bookmarkId: string,
): Promise<string[] | null> {
  const placement = await env.DB.prepare(
    `SELECT tag_id FROM bookmark_primary_category
      WHERE bookmark_id = ? AND status = 'accepted' LIMIT 1`,
  )
    .bind(bookmarkId)
    .first<{ tag_id: string }>();
  if (!placement) return null;

  const path: string[] = [];
  let cursor: string | null = placement.tag_id;
  // Depth-bounded walk guards against a corrupt tree looping forever.
  for (let depth = 0; cursor !== null && depth < 8; depth += 1) {
    const row: { name: string; parent_id: string | null } | null = await env.DB.prepare(
      `SELECT name, parent_id FROM tags WHERE id = ? AND user_id = ? LIMIT 1`,
    )
      .bind(cursor, userId)
      .first<{ name: string; parent_id: string | null }>();
    if (!row) break;
    path.unshift(row.name);
    cursor = row.parent_id;
  }
  return path.length > 0 ? path : null;
}

/**
 * Batch variant of `deriveCategoryPath` for the sync-pull page (C4-1): one
 * tag-tree load plus one chunked placement lookup serve every bookmark on the
 * page, instead of N per-bookmark upward walks. Returns a map keyed by
 * bookmark id that carries an entry for EVERY requested id (`null` when the
 * bookmark has no accepted placement), so callers can read it without
 * existence checks.
 */
export async function deriveCategoryPaths(
  env: Env,
  userId: string,
  bookmarkIds: string[],
): Promise<Map<string, string[] | null>> {
  const ids = [...new Set(bookmarkIds)];
  const result = new Map<string, string[] | null>();
  for (const id of ids) result.set(id, null);
  if (ids.length === 0) return result;

  // One tag-tree load serves every path derivation on this page (same shape
  // as loadCategoryWritebackPage's in-memory walk); centralised in loadTagNodes.
  const nodeById = await loadTagNodes(env, userId);

  // Chunk the id list so the IN (...) clause stays within D1's bound-param
  // limit (no leading params here, so the full chunk width is available).
  for (let i = 0; i < ids.length; i += D1_IN_CHUNK) {
    const slice = ids.slice(i, i + D1_IN_CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT bookmark_id, tag_id FROM bookmark_primary_category
        WHERE status = 'accepted' AND bookmark_id IN (${placeholders})`,
    )
      .bind(...slice)
      .all<{ bookmark_id: string; tag_id: string }>();
    for (const r of rows.results) {
      result.set(r.bookmark_id, deriveCategoryPathFromNodes(nodeById, r.tag_id));
    }
  }

  return result;
}

/**
 * Bumps `bookmarks.updated_at` so a category-only change enters the sync-pull
 * incremental stream (C5-2): the pull cursor keys on `updated_at`, and a
 * placement write alone would otherwise never reach the user's other browsers.
 * Scoped to the owning user; ids are chunked to respect D1's 100-param limit.
 */
async function bumpBookmarksUpdatedAt(
  env: Env,
  userId: string,
  bookmarkIds: string[],
  ts: string,
): Promise<void> {
  const ids = [...new Set(bookmarkIds)];
  // Two leading params (ts, userId) → the chunk ceiling shrinks accordingly.
  const CHUNK = D1_MAX_PARAMS - 2;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE bookmarks SET updated_at = ? WHERE user_id = ? AND id IN (${placeholders})`,
    )
      .bind(ts, userId, ...slice)
      .run();
  }
}

/** Bookmarks surfaced per writeback page. Keyset-paged so a large library streams. */
export const WRITEBACK_PAGE_SIZE = 500;

/**
 * Builds one page of the writeback mapping for the browser extension
 * (`GET /api/category/tree?format=writeback`, PRD §5.1 / §7.2).
 *
 * Returns every live, non-private bookmark carrying an ACCEPTED primary
 * placement, each with its derived `categoryPath`. The path is computed in
 * memory from a single tag-tree load (id → {name, parent_id}) rather than one
 * `deriveCategoryPath` query per bookmark — a 2,000-bookmark library would
 * otherwise issue thousands of round trips.
 *
 * Pagination is keyset over `bookmark_id` (the placement PK): the caller passes
 * the last `bookmarkId` it saw as `cursor`. We fetch `limit + 1` rows to detect
 * whether a next page exists without a separate COUNT per page; `total` is a
 * single cheap aggregate for the extension's progress bar.
 */
export async function loadCategoryWritebackPage(
  env: Env,
  userId: string,
  cursor: string | null = null,
  limit = WRITEBACK_PAGE_SIZE,
): Promise<CategoryWritebackPage> {
  // One tag-tree load serves every path derivation on this page; centralised
  // in loadTagNodes so the tree shape lives in exactly one place.
  const nodeById = await loadTagNodes(env, userId);

  const rows = await env.DB.prepare(
    `SELECT bpc.bookmark_id AS bookmark_id, bpc.tag_id AS tag_id, b.url AS url, b.title AS title
       FROM bookmark_primary_category bpc
       JOIN bookmarks b ON b.id = bpc.bookmark_id
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
        AND bpc.status = 'accepted' AND bpc.bookmark_id > ?
      ORDER BY bpc.bookmark_id
      LIMIT ?`,
  )
    .bind(userId, cursor ?? '', limit + 1)
    .all<{ bookmark_id: string; tag_id: string; url: string; title: string }>();

  const hasMore = rows.results.length > limit;
  const pageRows = hasMore ? rows.results.slice(0, limit) : rows.results;

  const items = pageRows.map((r) => ({
    bookmarkId: r.bookmark_id,
    url: r.url,
    title: r.title ?? '',
    categoryPath: deriveCategoryPathFromNodes(nodeById, r.tag_id),
  }));

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM bookmark_primary_category bpc
       JOIN bookmarks b ON b.id = bpc.bookmark_id
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
        AND bpc.status = 'accepted'`,
  )
    .bind(userId)
    .first<{ n: number }>();

  return {
    items,
    nextCursor: hasMore && items.length > 0 ? items[items.length - 1].bookmarkId : null,
    total: Number(totalRow?.n ?? 0),
  };
}

/**
 * Manually assigns (or re-assigns) the primary category for a set of bookmarks
 * (C2-3 drag / `/api/category/assign`). Writes `source = 'manual'` and records
 * a `modified` feedback event per bookmark so the loop learns from hand moves.
 * Returns the number of placements written.
 */
export async function assignPrimaryCategory(
  env: Env,
  userId: string,
  bookmarkIds: string[],
  tagId: string,
): Promise<number> {
  if (bookmarkIds.length === 0) return 0;

  // The target node must belong to this user.
  const tag = await env.DB.prepare(`SELECT id, name FROM tags WHERE id = ? AND user_id = ? LIMIT 1`)
    .bind(tagId, userId)
    .first<{ id: string; name: string }>();
  if (!tag) return 0;

  const ts = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const bookmarkId of bookmarkIds) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO bookmark_primary_category
           (bookmark_id, tag_id, confidence, source, job_id, status, decided_at, updated_at)
         VALUES (?, ?, NULL, 'manual', NULL, 'accepted', ?, ?)
         ON CONFLICT (bookmark_id) DO UPDATE SET
           tag_id = excluded.tag_id,
           confidence = excluded.confidence,
           source = excluded.source,
           status = excluded.status,
           decided_at = excluded.decided_at,
           updated_at = excluded.updated_at`,
      ).bind(bookmarkId, tagId, ts, ts),
    );
  }

  const BATCH_LIMIT = 90;
  for (let i = 0; i < statements.length; i += BATCH_LIMIT) {
    await env.DB.batch(statements.slice(i, i + BATCH_LIMIT));
  }

  // A manual move is a category change the user's other browsers must see:
  // bump updated_at so the row enters the sync-pull incremental stream (C5-2).
  await bumpBookmarksUpdatedAt(env, userId, bookmarkIds, ts);

  // Record the hand move as feedback so future categorize runs respect it.
  const path = await deriveCategoryPath(env, userId, bookmarkIds[0]);
  await recordFeedback(
    env,
    userId,
    bookmarkIds.map((bookmarkId) => ({
      bookmarkId,
      tagName: path?.join(' > ') ?? tag.name,
      action: 'modified' as const,
      source: 'manual',
      confidence: null,
      domain: null,
      context: tag.name,
    })),
  );

  return bookmarkIds.length;
}

/**
 * Undoes the placements one categorize job wrote (mirrors `undoJob`).
 *
 * Deletes the `source = 'ai'` placements traceable to this job and returns the
 * job's accepted category suggestions to `pending` so the user can decide again.
 * Manual / browser-folder placements are never touched — `source = 'ai'` and the
 * job id are the whole basis of the delete.
 */
export async function undoCategorizeJob(
  env: Env,
  userId: string,
  jobId: string,
): Promise<{ removedPlacements: number; restoredSuggestions: number }> {
  const del = await env.DB.prepare(
    `DELETE FROM bookmark_primary_category
      WHERE source = 'ai' AND job_id = ?
        AND EXISTS (
          SELECT 1 FROM bookmarks b
           WHERE b.id = bookmark_primary_category.bookmark_id AND b.user_id = ?
        )`,
  )
    .bind(jobId, userId)
    .run();

  const restore = await env.DB.prepare(
    `UPDATE tag_suggestions SET status = 'pending', decided_at = NULL
      WHERE user_id = ? AND job_id = ? AND kind = 'category' AND status = 'accepted'`,
  )
    .bind(userId, jobId)
    .run();

  return {
    removedPlacements: Number((del.meta as { changes?: number } | undefined)?.changes ?? 0),
    restoredSuggestions: Number((restore.meta as { changes?: number } | undefined)?.changes ?? 0),
  };
}

/* ================================================================== *
 * Rename mode (structured-organise Phase B)
 *
 * A rename proposal lives in `tag_suggestions` with `kind = 'rename'`:
 *   - `tag_name`  → the NEW title (what accept will write);
 *   - `topic`     → the ORIGINAL title it would replace — the undo basis.
 * `topic` is reused deliberately: rename rows never carry topic
 * semantics (no clustering, no distribution), so a stale title rides
 * for free and `undoRenameJob` can restore `bookmarks.title` without a
 * new column or migration. Rows are always created from a live bookmark
 * read (the engine input), so the original title is current at
 * proposal time; undo validates the live title still matches before
 * restoring, so an edit made between accept and undo is never clobbered.
 * ================================================================== */

/** Upper bound for a stored title (new or original) — mirrors the prompt cap. */
const RENAME_TITLE_MAX = 100;

/**
 * Replaces the pending RENAME suggestions for the given bookmarks.
 *
 * Mirrors `saveCategorySuggestions` but scoped to `kind = 'rename'`: the delete
 * only touches rename rows, and the insert stores the new title in `tag_name`
 * and the current (original) title in `topic`. Bookmarks whose current title
 * already equals the proposal are skipped — the engine filters too, but the
 * title could have changed between engine and save.
 */
export async function saveRenameSuggestions(
  env: Env,
  userId: string,
  jobId: string | null,
  results: RenameResult[],
): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  const ts = nowIso();
  let written = 0;

  for (const result of results) {
    const candidate = result.rename;
    if (!candidate) continue;

    // Load the CURRENT title: it is both the dedupe anchor and the undo basis.
    // `b` alias is REQUIRED: PRIVATE_BOOKMARK_CLAUSE references b.is_private / b.id.
    const row = await env.DB.prepare(
      `SELECT title FROM bookmarks b
        WHERE b.id = ? AND b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}`,
    )
      .bind(result.bookmarkId, userId)
      .first<{ title: string | null }>();
    const currentTitle = String(row?.title ?? '').trim();
    if (!currentTitle || currentTitle === candidate.title.trim()) continue;

    statements.push(
      env.DB.prepare(
        `DELETE FROM tag_suggestions
          WHERE bookmark_id = ? AND user_id = ? AND kind = 'rename' AND status = 'pending'`,
      ).bind(result.bookmarkId, userId),
    );

    statements.push(
      env.DB.prepare(
        `INSERT INTO tag_suggestions
           (id, user_id, bookmark_id, job_id, tag_name, tag_id, confidence, source, reason,
            topic, needs_review, feedback_boosted, kind, status, created_at)
         SELECT ?, ?, ?, ?, ?, NULL, ?, 'model', ?, ?, 0, 0, 'rename', 'pending', ?
          WHERE NOT EXISTS (
            SELECT 1 FROM tag_suggestions s
             WHERE s.bookmark_id = ? AND s.kind = 'rename'
               AND s.tag_name = ? COLLATE NOCASE AND s.status = 'rejected'
          )`,
      ).bind(
        newId(),
        userId,
        result.bookmarkId,
        jobId,
        candidate.title.trim().slice(0, RENAME_TITLE_MAX),
        0.9,
        candidate.reason,
        currentTitle.slice(0, RENAME_TITLE_MAX),
        ts,
        result.bookmarkId,
        candidate.title.trim(),
      ),
    );
    written += 1;
  }

  if (statements.length > 0) {
    const BATCH_STATEMENT_LIMIT = 100;
    for (let i = 0; i < statements.length; i += BATCH_STATEMENT_LIMIT) {
      // D1 并发写入偶发 SQLITE_BUSY / 连接器重置：批次整体原子回滚，重试安全。
      await withD1Retry(() => env.DB.batch(statements.slice(i, i + BATCH_STATEMENT_LIMIT)));
    }
  }
  return written;
}

/**
 * Accepts or rejects RENAME suggestions.
 *
 * Accept rewrites `bookmarks.title` (the extension's sync-pull reconciler then
 * propagates the change into the browser bookmark tree via `chrome.bookmarks.update`).
 * The bookmark's `updated_at` is bumped so the title change enters the
 * sync-pull incremental stream, exactly like a category accept. Rename rows
 * participate in the unified `markDecided` flow but never touch `bookmark_tags`
 * or `bookmark_primary_category`.
 */
export async function decideRenameSuggestions(
  env: Env,
  userId: string,
  ids: string[],
  action: 'accept' | 'reject',
): Promise<{ accepted: number; rejected: number }> {
  if (ids.length === 0) return { accepted: 0, rejected: 0 };

  const rows = await queryInChunks<Record<string, unknown>, Record<string, unknown>>(
    env.DB,
    ids,
    [userId],
    (ph) =>
      `SELECT s.id, s.bookmark_id, s.tag_name, s.topic, s.reason,
              b.url AS bookmark_url, b.title AS bookmark_title
         FROM tag_suggestions s
         JOIN bookmarks b ON b.id = s.bookmark_id AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
        WHERE s.user_id = ? AND s.status = 'pending' AND s.kind = 'rename' AND s.id IN (${ph})`,
    (r) => r,
  );

  if (rows.length === 0) return { accepted: 0, rejected: 0 };

  const ts = nowIso();
  const foundIds = rows.map((r) => String(r.id));

  if (action === 'reject') {
    await markDecided(env, userId, foundIds, 'rejected', ts);
    return { accepted: 0, rejected: foundIds.length };
  }

  // Accept: rewrite each bookmark's title, skipping rows whose live title no
  // longer matches the original recorded at proposal time (the user edited it
  // while the proposal sat in the queue — their edit outranks the model).
  const applied: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const newTitle = String(row.tag_name ?? '').trim().slice(0, RENAME_TITLE_MAX);
    const originalTitle = String(row.topic ?? '').trim();
    const liveTitle = String(row.bookmark_title ?? '').trim();
    if (!newTitle || !originalTitle || liveTitle !== originalTitle) continue;

    statements.push(
      env.DB.prepare(`UPDATE bookmarks SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`).bind(
        newTitle,
        ts,
        String(row.bookmark_id),
        userId,
      ),
    );
    applied.push(String(row.bookmark_id));
  }

  const BATCH_LIMIT = 90;
  for (let i = 0; i < statements.length; i += BATCH_LIMIT) {
    await env.DB.batch(statements.slice(i, i + BATCH_LIMIT));
  }

  // Title-only changes never touch the placement tree, but other browsers must
  // still see them — the updated_at bump above is what carries the change into
  // the sync-pull incremental stream (C5-2).

  await markDecided(env, userId, foundIds, 'accepted', ts);

  // Feedback: record each accepted rename as a 'modified' event keyed by the
  // original title, so future runs learn which boilerplate the user trims.
  if (applied.length > 0) {
    const feedback: FeedbackRecord[] = rows
      .filter((r) => applied.includes(String(r.bookmark_id)))
      .map((r) => {
        const domain = hostOf(String(r.bookmark_url ?? ''));
        return {
          bookmarkId: String(r.bookmark_id),
          tagName: `rename:${String(r.topic ?? '')}`,
          action: 'modified' as const,
          finalTagId: null,
          source: 'model',
          confidence: null,
          domain,
          context: String(r.reason ?? '').slice(0, 24) || String(r.tag_name ?? ''),
        };
      });
    try {
      await recordFeedback(env, userId, feedback);
    } catch {
      /* feedback is advisory — never fail the apply */
    }
  }

  return { accepted: applied.length, rejected: 0 };
}

/**
 * Undoes the title rewrites one rename job produced (mirrors `undoCategorizeJob`).
 *
 * Restores `bookmarks.title` from the ORIGINAL recorded in each accepted
 * suggestion's `topic` column — but only when the live title still matches the
 * accepted proposal, so a manual edit made after accepting is never clobbered.
 * Accepted rename suggestions return to `pending` so the user can decide again.
 */
export async function undoRenameJob(
  env: Env,
  userId: string,
  jobId: string,
): Promise<{ restoredTitles: number; restoredSuggestions: number }> {
  // Load accepted rename rows joined to their live bookmark titles.
  const rows = await env.DB.prepare(
    `SELECT s.id AS sid, s.bookmark_id, s.tag_name AS new_title, s.topic AS original_title,
            b.title AS live_title
       FROM tag_suggestions s
       JOIN bookmarks b ON b.id = s.bookmark_id AND b.user_id = ? AND b.deleted_at IS NULL
      WHERE s.user_id = ? AND s.job_id = ? AND s.kind = 'rename' AND s.status = 'accepted'`,
  )
    .bind(userId, userId, jobId)
    .all<Record<string, unknown>>();

  const ts = nowIso();
  const restoreStatements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    const newTitle = String(row.new_title ?? '').trim();
    const originalTitle = String(row.original_title ?? '').trim();
    const liveTitle = String(row.live_title ?? '').trim();
    // Only restore when the live title is still exactly what the accept wrote;
    // a manual edit since then wins.
    if (!originalTitle || !newTitle || liveTitle !== newTitle) continue;
    restoreStatements.push(
      env.DB.prepare(`UPDATE bookmarks SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`).bind(
        originalTitle,
        ts,
        String(row.bookmark_id),
        userId,
      ),
    );
  }

  for (let i = 0; i < restoreStatements.length; i += 90) {
    await env.DB.batch(restoreStatements.slice(i, i + 90));
  }

  const restore = await env.DB.prepare(
    `UPDATE tag_suggestions SET status = 'pending', decided_at = NULL
      WHERE user_id = ? AND job_id = ? AND kind = 'rename' AND status = 'accepted'`,
  )
    .bind(userId, jobId)
    .run();

  return {
    restoredTitles: restoreStatements.length,
    restoredSuggestions: Number((restore.meta as { changes?: number } | undefined)?.changes ?? 0),
  };
}

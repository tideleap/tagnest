import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import { newId, nowIso } from '../../_lib/ids';
import { ensureTags, setBookmarkTags } from '../../_lib/db';
import { canonicalUrl, hostOf, titleFallback, urlKey } from '../../_lib/urlkey';
import { ensureCategoryPath } from '../../_lib/ai/store';
import { recordFeedback } from '../../_lib/ai/feedback';

/**
 * Batch push of local browser-extension changes into TagNest (the hub of the
 * hub-and-spoke changelog). One POST carries the full set of local mutations
 * collected since the last sync watermark; the endpoint applies each
 * independently and reports per-change failures so a single bad row never
 * aborts the whole batch.
 *
 * Semantics
 * ---------
 * - `upsert`: canonicalises the URL, then pre-looks-up by `url_key`. A missing
 *   row is INSERTed; a live or soft-deleted row is UPDATEd (a soft-deleted row
 *   is *revived* — `deleted_at = NULL` — because the spoke re-surfaced it).
 *   Field-level last-write-wins applies: when the change carries an `updatedAt`
 *   and the existing row is already newer, the field update is skipped (tags
 *   are still reconciled, idempotently). No AI enrichment or snapshot capture
 *   runs here — sync must stay cheap and deterministic.
 * - `delete`: soft-deletes the live row matching `url_key` (a browser deletion
 *   is a soft-delete, never a hard purge). Deleting an already-deleted or
 *   absent row is a no-op success.
 * - `categoryPath` (C4-3): an upsert may carry the bookmark's folder path
 *   inside the extension's managed folder. The path is resolved (and created,
 *   level by level) via `ensureCategoryPath`, then written as the bookmark's
 *   single primary placement with `source = 'browser_folder'` — the same
 *   source the writeback builder protects from AI re-placement. A `modified`
 *   feedback event is recorded so the categoriser learns from hand moves, and
 *   `bookmarks.updated_at` is bumped so the placement reaches the user's other
 *   browsers through sync-pull (C5-2). A malformed path is reported in
 *   `errors` without failing the rest of the change (fields/tags still apply).
 *
 * Response: `{ applied, failed, errors:[{index, code, message}] }`. `applied`
 * plus `failed` equals the number of changes received.
 */

const MAX_CHANGES = 500;

/** Deepest folder nesting a pushed category path may declare. */
const MAX_CATEGORY_DEPTH = 8;

type Change =
  | {
      op: 'upsert';
      url: string;
      title?: string;
      description?: string | null;
      note?: string | null;
      tagNames?: string[];
      /** Folder path inside the managed folder, root first (C4-3). */
      categoryPath?: string[] | null;
      updatedAt?: string;
    }
  | {
      op: 'delete';
      url: string;
      updatedAt?: string;
    };

interface PushError {
  index: number;
  code: string;
  message: string;
}

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ changes?: unknown }>(ctx.request);

  if (!Array.isArray(body.changes)) {
    throw badRequest('changes 必须是数组', { changes: 'expected array' });
  }
  if (body.changes.length === 0) {
    return json({ applied: 0, failed: 0, errors: [] });
  }
  if (body.changes.length > MAX_CHANGES) {
    throw badRequest(`单次同步变更不能超过 ${MAX_CHANGES} 条`, { changes: 'too many' });
  }

  const errors: PushError[] = [];
  let applied = 0;

  for (let index = 0; index < body.changes.length; index += 1) {
    const raw = body.changes[index] as Partial<Change> | null;
    if (!raw || (raw.op !== 'upsert' && raw.op !== 'delete')) {
      errors.push({ index, code: 'invalid_op', message: 'op 必须是 upsert 或 delete' });
      continue;
    }

    const url = canonicalUrl(typeof raw.url === 'string' ? raw.url : '');
    if (!url) {
      errors.push({ index, code: 'invalid_url', message: '网址格式不正确' });
      continue;
    }
    const key = urlKey(url);

    // --- categoryPath shape check (C4-3) --------------------------------
    // Absent / null / [] means "no category information in this change" — the
    // bookmark's placement is left untouched. A present path must be at most
    // MAX_CATEGORY_DEPTH non-empty strings; anything else fails this change
    // outright (like invalid_url) so a buggy spoke cannot silently diverge.
    let categoryPath: string[] | null = null;
    if (raw.op === 'upsert') {
      const rawPath = (raw as Extract<Change, { op: 'upsert' }>).categoryPath;
      if (rawPath !== undefined && rawPath !== null) {
        if (
          !Array.isArray(rawPath) ||
          rawPath.length > MAX_CATEGORY_DEPTH ||
          rawPath.some((s) => typeof s !== 'string' || s.trim().length === 0)
        ) {
          errors.push({
            index,
            code: 'invalid_category_path',
            message: `categoryPath 必须是不超过 ${MAX_CATEGORY_DEPTH} 层的非空字符串数组`,
          });
          continue;
        }
        if (rawPath.length > 0) {
          categoryPath = (rawPath as string[]).map((s) => s.trim());
        }
      }
    }

    try {
      if (raw.op === 'delete') {
        await deleteByKey(ctx.env, userId, key);
        applied += 1;
        continue;
      }

      // --- upsert -------------------------------------------------------
      const up = raw as Extract<Change, { op: 'upsert' }>;
      const existing = await ctx.env.DB.prepare(
        `SELECT id, updated_at, deleted_at, is_favorite, is_archived
           FROM bookmarks WHERE user_id = ? AND url_key = ? LIMIT 1`,
      )
        .bind(userId, key)
        .first<{ id: string; updated_at: string; deleted_at: string | null; is_favorite: number; is_archived: number }>();

      const title = (typeof up.title === 'string' && up.title.trim()) || titleFallback(url);
      const description = up.description ? String(up.description).slice(0, 2000) : null;
      const note = up.note ? String(up.note).slice(0, 20000) : null;
      const ts = nowIso();

      // Last-write-wins gate: skip the field write if the server row is already
      // newer than the change carrying a timestamp. Tags are reconciled anyway.
      const changeTs = up.updatedAt ?? null;
      const applyFields = !changeTs || changeTs >= (existing?.updated_at ?? '');

      let bookmarkId: string;
      if (!existing) {
        bookmarkId = newId();
        await ctx.env.DB.prepare(
          `INSERT INTO bookmarks
             (id, user_id, url, url_key, title, description, note, is_favorite, is_archived, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
          .bind(
            bookmarkId,
            userId,
            url,
            key,
            title.slice(0, 300),
            description,
            note,
            0,
            0,
            ts,
            ts,
          )
          .run();
      } else {
        bookmarkId = existing.id;
        if (applyFields) {
          await ctx.env.DB.prepare(
            `UPDATE bookmarks
               SET title = ?, description = ?, note = ?, updated_at = ?, deleted_at = ?
             WHERE id = ? AND user_id = ?`,
          )
            .bind(
              title.slice(0, 300),
              description,
              note,
              ts,
              null, // revive if it was soft-deleted
              bookmarkId,
              userId,
            )
            .run();
        } else {
          // Still bump updated_at so the next incremental pull reflects the touch.
          await ctx.env.DB.prepare(
            `UPDATE bookmarks SET updated_at = ? WHERE id = ? AND user_id = ?`,
          )
            .bind(ts, bookmarkId, userId)
            .run();
        }
      }

      const tagNames = Array.isArray(up.tagNames) ? up.tagNames.slice(0, 30) : [];
      if (tagNames.length > 0) {
        const { ids } = await ensureTags(ctx.env, userId, tagNames);
        await setBookmarkTags(ctx.env, bookmarkId, ids);
      }

      // --- primary category placement (C4-3) ----------------------------
      // Resolve/create the folder chain, write the single placement with
      // source='browser_folder', record a feedback event, and bump updated_at
      // so the move propagates to the user's other browsers (C5-2).
      if (categoryPath !== null) {
        await applyBrowserFolderPlacement(ctx.env, userId, bookmarkId, url, title, categoryPath);
      }

      applied += 1;
    } catch (err) {
      errors.push({
        index,
        code: 'server_error',
        message: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return json({ applied, failed: errors.length, errors });
};

async function deleteByKey(env: Env, userId: string, key: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE bookmarks SET deleted_at = ?, updated_at = ?
       WHERE user_id = ? AND url_key = ? AND deleted_at IS NULL`,
  )
    .bind(nowIso(), nowIso(), userId, key)
    .run();
}

/**
 * Writes the browser-folder placement for one pushed bookmark (C4-3).
 *
 * `ensureCategoryPath` resolves or creates each level of the folder chain
 * (case-insensitive reuse under the same parent), then the single
 * `bookmark_primary_category` row is upserted with `source = 'browser_folder'`
 * — the source the categoriser's scope resolver protects from AI re-placement.
 * A `modified` feedback event teaches the loop that the user chose this path,
 * and `bookmarks.updated_at` is bumped so the placement enters the sync-pull
 * stream for the user's other browsers (C5-2).
 */
async function applyBrowserFolderPlacement(
  env: Env,
  userId: string,
  bookmarkId: string,
  url: string,
  title: string,
  path: string[],
): Promise<void> {
  const { leafTagId } = await ensureCategoryPath(env, userId, path);
  const ts = nowIso();

  await env.DB.prepare(
    `INSERT INTO bookmark_primary_category
       (bookmark_id, tag_id, confidence, source, job_id, status, decided_at, updated_at)
     VALUES (?, ?, NULL, 'browser_folder', NULL, 'accepted', ?, ?)
     ON CONFLICT (bookmark_id) DO UPDATE SET
       tag_id = excluded.tag_id,
       confidence = excluded.confidence,
       source = excluded.source,
       job_id = excluded.job_id,
       status = excluded.status,
       decided_at = excluded.decided_at,
       updated_at = excluded.updated_at`,
  )
    .bind(bookmarkId, leafTagId, ts, ts)
    .run();

  // Bump the bookmark so the category change reaches other browsers (C5-2).
  await env.DB.prepare(
    `UPDATE bookmarks SET updated_at = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(ts, bookmarkId, userId)
    .run();

  await recordFeedback(env, userId, [
    {
      bookmarkId,
      tagName: path.join(' > '),
      action: 'modified',
      source: 'browser_folder',
      confidence: null,
      domain: hostOf(url),
      context: title,
    },
  ]);
}

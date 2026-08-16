import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, notFound, readJson } from '../../_lib/http';
import { newId, nowIso } from '../../_lib/ids';
import { ensureTags, queryInChunks } from '../../_lib/db';
import type { ParsedItem } from '../../_lib/import-parsers';
import { planImportRow } from '../../_lib/import-plan';
import { faviconFor, titleFallback, urlKey } from '../../_lib/urlkey';

/**
 * Writes a staged import.
 *
 * Rows go in batches rather than one statement per bookmark: a 10k-item import
 * as 10k round trips would exceed the request budget several times over.
 */
const WRITE_BATCH = 50;

/**
 * D1 rejects a batch holding more than 100 statements. A full write batch is
 * 50 bookmarks plus their tag links, which passes 100 as soon as items carry
 * more than one tag, so every batch is sliced before it reaches the wire.
 */
const BATCH_STATEMENT_LIMIT = 100;

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{
    token?: string;
    foldersAsTags?: boolean;
    skipDuplicates?: boolean;
    extraTagNames?: string[];
  }>(ctx.request);

  const token = String(body.token ?? '');
  if (!token) throw badRequest('缺少导入令牌');

  const staged = await ctx.env.DB.prepare(
    `SELECT payload FROM import_staging WHERE token = ? AND user_id = ? AND expires_at > ? LIMIT 1`,
  )
    .bind(token, userId, nowIso())
    .first<{ payload: string }>();

  if (!staged) throw notFound('导入会话已过期，请重新上传文件');

  let items: ParsedItem[];
  try {
    items = JSON.parse(staged.payload) as ParsedItem[];
  } catch {
    throw badRequest('导入数据已损坏，请重新上传');
  }

  const foldersAsTags = body.foldersAsTags !== false;
  const skipDuplicates = body.skipDuplicates !== false;
  const extraNames = Array.isArray(body.extraTagNames)
    ? body.extraTagNames.map(String).slice(0, 10)
    : [];

  /* ---- Resolve every tag up front ------------------------------- */

  const wanted = new Set<string>(extraNames);
  for (const item of items) {
    for (const t of item.tagNames) wanted.add(t);
    if (foldersAsTags) {
      // Only the leaf folder becomes a tag. Turning every ancestor into one
      // produces a wall of near-useless chips like "Bookmarks bar".
      const leaf = item.folderPath[item.folderPath.length - 1];
      if (leaf) wanted.add(leaf);
    }
  }

  const before = await countTags(ctx.env, userId);
  const { ids: resolvedIds } = await ensureTags(ctx.env, userId, [...wanted]);
  const after = await countTags(ctx.env, userId);

  const tagIdByLower = new Map<string, string>();
  if (resolvedIds.length > 0) {
    const rows = await queryInChunks<{ id: string; name: string }, { id: string; name: string }>(
      ctx.env.DB,
      resolvedIds,
      [userId],
      (ph) => `SELECT id, name FROM tags WHERE user_id = ? AND id IN (${ph})`,
      (r) => r,
    );
    for (const r of rows) tagIdByLower.set(r.name.toLowerCase(), r.id);
  }

  const extraIds = extraNames
    .map((n) => tagIdByLower.get(n.trim().toLowerCase()))
    .filter((v): v is string => Boolean(v));

  /* ---- Existing URLs -------------------------------------------- */

  // key → id of the bookmark that already holds that URL. The id matters:
  // without it the writer cannot attach tags to a URL it is not allowed to
  // insert again (see `planImportRow`).
  const existing = await loadExistingIdsByKey(ctx.env, userId, items.map((i) => urlKey(i.url)));

  /* ---- Write (streams progress as batches commit) --------------- */

  const total = items.length;
  const ts = nowIso();
  const encoder = new TextEncoder();
  const progress = (done: number, skipped: number, failed: number) =>
    `${JSON.stringify({ type: 'progress', done, total, skipped, failed })}\n`;

  // Build the NDJSON body as a stream so a large import reports live progress
  // instead of holding the client questioningly at 0% until the last batch.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let imported = 0;
      let skipped = 0;
      let failed = 0;

      const tagLink = (bookmarkId: string, tagId: string) =>
        ctx.env.DB.prepare(
          `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)`,
        ).bind(bookmarkId, tagId);

      for (let i = 0; i < items.length; i += WRITE_BATCH) {
        const chunk = items.slice(i, i + WRITE_BATCH);
        // Grouped per row, not one flat list: when a batch is rejected the
        // writer replays it row by row, and that only works if it knows which
        // statements belong together.
        const rows: { statements: D1PreparedStatement[]; isNew: boolean }[] = [];

        for (const item of chunk) {
          const key = urlKey(item.url);
          const plan = planImportRow(item, key, {
            existing,
            tagIdByLower,
            extraIds,
            foldersAsTags,
            skipDuplicates,
            newId,
          });

          if (plan.kind === 'skip') {
            skipped += 1;
            continue;
          }

          if (plan.kind === 'merge') {
            // The URL is already live and the schema forbids a second row, so
            // the honest outcome is "merge this file's tags onto the bookmark
            // that is already there" — counted as skipped because no new
            // bookmark was created.
            rows.push({
              statements: plan.tagIds.map((t) => tagLink(plan.bookmarkId, t)),
              isNew: false,
            });
            skipped += 1;
            continue;
          }

          rows.push({
            statements: [
              ctx.env.DB.prepare(
                `INSERT OR IGNORE INTO bookmarks
                   (id, user_id, url, url_key, title, description, favicon_url, cover_url, note,
                    ai_summary, is_favorite, is_archived, visit_count, last_visited_at,
                    snapshot_key, snapshot_keys, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 0, 0, 0, NULL, ?, ?, ?, ?, NULL)`,
              ).bind(
                plan.bookmarkId,
                userId,
                item.url,
                key,
                (item.title || titleFallback(item.url)).slice(0, 300),
                faviconFor(item.url),
                // Y4: carry snapshot references from a TagNest→TagNest migration
                // package. `merge`/`skip` paths leave the existing bookmark's
                // snapshots untouched on purpose (see docs/EXPORT-SCHEMA.md).
                item.snapshotKey ?? null,
                JSON.stringify(item.snapshotKeys ?? []),
                item.addedAt ?? ts,
                ts,
              ),
              ...plan.tagIds.map((t) => tagLink(plan.bookmarkId, t)),
            ],
            isNew: true,
          });

          imported += 1;
        }

        const statements = rows.flatMap((r) => r.statements);
        if (statements.length > 0) {
          try {
            await runBatched(ctx.env.DB, statements);
          } catch (e) {
            // A batch can still be rejected by something outside our control —
            // most plausibly a URL saved from the extension while the import
            // was running. Replaying row by row bounds the damage to the one
            // row that is actually bad instead of the surrounding 49.
            console.error('[tagnest] import batch failed, retrying row by row', e);
            for (const row of rows) {
              try {
                await runBatched(ctx.env.DB, row.statements);
              } catch (rowError) {
                console.error('[tagnest] import row failed', rowError);
                if (row.isNew) {
                  failed += 1;
                  imported -= 1;
                }
              }
            }
          }
        }

        const done = Math.min(i + chunk.length, total);
        controller.enqueue(encoder.encode(progress(done, skipped, failed)));
      }

      await ctx.env.DB.prepare(`DELETE FROM import_staging WHERE token = ?`).bind(token).run();

      const result = {
        type: 'result',
        imported: Math.max(imported, 0),
        skipped,
        failed: Math.max(failed, 0),
        tagsCreated: Math.max(after - before, 0),
      };
      controller.enqueue(encoder.encode(`${JSON.stringify(result)}\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};

async function countTags(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM tags WHERE user_id = ?`)
    .bind(userId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/** Splits a statement list so no single `batch()` exceeds D1's 100-statement cap. */
async function runBatched(db: Env['DB'], statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_STATEMENT_LIMIT) {
    await db.batch(statements.slice(i, i + BATCH_STATEMENT_LIMIT));
  }
}

/** Maps every already-stored `url_key` to the id of the live bookmark holding it. */
async function loadExistingIdsByKey(
  env: Env,
  userId: string,
  keys: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(keys)];
  const rows = await queryInChunks<
    { id: string; url_key: string },
    { id: string; url_key: string }
  >(
    env.DB,
    unique,
    [userId],
    (ph) =>
      `SELECT id, url_key FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL AND url_key IN (${ph})`,
    (r) => r,
  );
  return new Map(rows.map((r) => [r.url_key, r.id]));
}

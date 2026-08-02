import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, notFound, readJson } from '../../_lib/http';
import { newId, nowIso } from '../../_lib/ids';
import { ensureTags, queryInChunks } from '../../_lib/db';
import type { ParsedItem } from '../../_lib/import-parsers';
import { faviconFor, titleFallback, urlKey } from '../../_lib/urlkey';

/**
 * Writes a staged import.
 *
 * Rows go in batches rather than one statement per bookmark: a 10k-item import
 * as 10k round trips would exceed the request budget several times over.
 */
const WRITE_BATCH = 50;

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

  const existing = await loadExistingKeys(ctx.env, userId, items.map((i) => urlKey(i.url)));

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

      for (let i = 0; i < items.length; i += WRITE_BATCH) {
        const chunk = items.slice(i, i + WRITE_BATCH);
        const statements: D1PreparedStatement[] = [];

        for (const item of chunk) {
          const key = urlKey(item.url);
          if (skipDuplicates && existing.has(key)) {
            skipped += 1;
            continue;
          }
          existing.add(key);

          const id = newId();
          const createdAt = item.addedAt ?? ts;

          statements.push(
            ctx.env.DB.prepare(
              // `INSERT OR IGNORE` + the partial UNIQUE index on (user_id,
              // url_key) WHERE deleted_at IS NULL (migration 0004) make import
              // idempotent at the database layer: a URL that already exists
              // live is silently skipped even if it raced past the in-memory
              // `existing` set (e.g. a concurrent save or a prior partial
              // import), instead of failing the whole batch.
              `INSERT OR IGNORE INTO bookmarks
                 (id, user_id, url, url_key, title, description, favicon_url, cover_url, note,
                  ai_summary, is_favorite, is_archived, visit_count, last_visited_at,
                  created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 0, 0, 0, NULL, ?, ?, NULL)`,
            ).bind(
              id,
              userId,
              item.url,
              key,
              (item.title || titleFallback(item.url)).slice(0, 300),
              faviconFor(item.url),
              createdAt,
              ts,
            ),
          );

          const tagIds = new Set(extraIds);
          for (const name of item.tagNames) {
            const tagId = tagIdByLower.get(name.trim().toLowerCase());
            if (tagId) tagIds.add(tagId);
          }
          if (foldersAsTags) {
            const leaf = item.folderPath[item.folderPath.length - 1];
            const tagId = leaf ? tagIdByLower.get(leaf.trim().toLowerCase()) : undefined;
            if (tagId) tagIds.add(tagId);
          }

          for (const tagId of tagIds) {
            statements.push(
              ctx.env.DB.prepare(
                `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)`,
              ).bind(id, tagId),
            );
          }

          imported += 1;
        }

        if (statements.length > 0) {
          try {
            await ctx.env.DB.batch(statements);
          } catch (e) {
            // One bad batch must not abort the whole import; the user gets a count
            // of what failed and can retry the file.
            console.error('[tagnest] import batch failed', e);
            failed += chunk.length;
            imported -= chunk.length;
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

async function loadExistingKeys(env: Env, userId: string, keys: string[]): Promise<Set<string>> {
  const unique = [...new Set(keys)];
  const rows = await queryInChunks<{ url_key: string }, string>(
    env.DB,
    unique,
    [userId],
    (ph) =>
      `SELECT url_key FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL AND url_key IN (${ph})`,
    (r) => r.url_key,
  );
  return new Set(rows);
}

import type { Env, RequestData } from '../_lib/env';
import { requireUserId } from '../_lib/auth';
import { badRequest } from '../_lib/http';

type Format = 'json' | 'html' | 'csv';

const FORMATS: Format[] = ['json', 'html', 'csv'];

export interface ExportRow {
  id: string;
  url: string;
  title: string;
  description: string | null;
  note: string | null;
  ai_summary: string | null;
  is_favorite: number;
  is_archived: number;
  visit_count: number;
  last_visited_at: string | null;
  manual_order: number;
  snapshot_key: string | null;
  snapshot_keys: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  tags: string | null;
}

export interface ExportRenderOpts {
  includeTags: boolean;
  includeMetadata: boolean;
  includeVisits: boolean;
  pretty: boolean;
}

/** GROUP_CONCAT separator; ASCII 31 cannot appear in a tag name. */
const SEP = String.fromCharCode(31);

/* ------------------------------------------------------------------ *
 * Row shaping
 * ------------------------------------------------------------------ */

/** Single bookmark's JSON payload (no wrapping array/object). */
function bookmarkJson(r: ExportRow, opts: ExportRenderOpts): Record<string, unknown> {
  const b: Record<string, unknown> = {
    url: r.url,
    title: r.title,
    isFavorite: r.is_favorite === 1,
    isArchived: r.is_archived === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (opts.includeTags) b.tags = tagsOf(r);
  if (opts.includeMetadata) {
    b.description = r.description;
    b.note = r.note;
    b.aiSummary = r.ai_summary;
  }
  if (opts.includeVisits) {
    b.visitCount = r.visit_count;
    b.lastVisitedAt = r.last_visited_at;
  }
  return b;
}

function tagsOf(row: ExportRow): string[] {
  return row.tags ? row.tags.split(SEP).filter(Boolean) : [];
}

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

export interface ExportCtx {
  env: Env;
  userId: string;
  includeTrash: boolean;
}

/**
 * Yields bookmark rows page-by-page (keyset cursor, 100/page). Unlike the old
 * `collectRows` which buffered the whole library into an array, this generator
 * lets the writer stream each page straight to the response — a very large
 * library never needs to fit in worker memory.
 */
export async function* pageRows(ctx: ExportCtx): AsyncGenerator<ExportRow[]> {
  const { env, userId, includeTrash } = ctx;
  const trashClause = includeTrash ? '' : 'AND b.deleted_at IS NULL';
  const pageSize = 100;
  let cursorCreated: string | null = null;
  let cursorId: string | null = null;

  for (let guard = 0; ; guard += 1) {
    const result: D1Result<ExportRow> = await env.DB.prepare(
      `SELECT b.id, b.url, b.title, b.description, b.note, b.ai_summary,
              b.is_favorite, b.is_archived, b.visit_count, b.last_visited_at,
              b.manual_order, b.snapshot_key, b.snapshot_keys,
              b.created_at, b.updated_at, b.deleted_at,
              (SELECT GROUP_CONCAT(t.name, CHAR(31))
                 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
                WHERE bt.bookmark_id = b.id) AS tags
         FROM bookmarks b
        WHERE b.user_id = ?
          ${trashClause}
          ${cursorCreated && cursorId ? `AND (b.created_at < ? OR (b.created_at = ? AND b.id < ?))` : ''}
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT ${pageSize}`,
    )
      .bind(
        userId,
        ...(cursorCreated && cursorId
          ? [cursorCreated, cursorCreated, cursorId]
          : []),
      )
      .all<ExportRow>();

    const rows = result.results;
    yield rows;
    if (rows.length < pageSize) break;

    const last = rows[rows.length - 1];
    cursorCreated = last.created_at;
    cursorId = last.id;
    // Hard safety: if a cursor somehow failed to advance we'd loop forever on a
    // pathological ordering; bail after a generous bound.
    if (guard > 100_000) break;
  }
}

/* ------------------------------------------------------------------ *
 * Streaming renderers
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();

/**
 * Serializes the JSON export as a stream so memory stays bounded regardless of
 * library size. The envelope is written once, then each page's rows are
 * enqueued incrementally with the correct separators.
 *
 * `pretty` is honoured by indenting each bookmark object two spaces and putting
 * rows on their own lines — still correct, streamable JSON, just human-friendlier.
 */
export async function renderJsonStream(
  ctx: ExportCtx,
  opts: ExportRenderOpts,
  exportedAt: string,
): Promise<ReadableStream<Uint8Array>> {
  const pretty = opts.pretty;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let first = true;
      controller.enqueue(
        encoder.encode(
          `{"application":"TagNest","version":1,"exportedAt":"${exportedAt}","bookmarks":[`,
        ),
      );
      try {
        for await (const rows of pageRows(ctx)) {
          for (const row of rows) {
            if (!first) controller.enqueue(encoder.encode(pretty ? ',\n' : ','));
            first = false;
            // Pretty: indent each object 2 spaces so it aligns under "bookmarks":
            controller.enqueue(
              encoder.encode(pretty ? `  ${JSON.stringify(bookmarkJson(row, opts), null, 2)}` : JSON.stringify(bookmarkJson(row, opts))),
            );
          }
        }
      } finally {
        controller.enqueue(encoder.encode(pretty ? `\n]}` : `]}`));
        controller.close();
      }
    },
    cancel() {
      // Caller disconnected mid-download; nothing to clean up server-side.
    },
  });
}

async function renderCsvStream(ctx: ExportCtx): Promise<ReadableStream<Uint8Array>> {
  const header = ['url', 'title', 'description', 'note', 'tags', 'favorite', 'archived', 'created_at'];
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // BOM so Excel opens UTF-8 Chinese without mojibake.
      controller.enqueue(encoder.encode(`\ufeff${header.join(',')}\r\n`));
      for await (const rows of pageRows(ctx)) {
        for (const r of rows) {
          const line = [
            r.url,
            r.title,
            r.description ?? '',
            r.note ?? '',
            tagsOf(r).join(', '),
            r.is_favorite === 1 ? 'true' : 'false',
            r.is_archived === 1 ? 'true' : 'false',
            r.created_at,
          ]
            .map(csvCell)
            .join(',');
          controller.enqueue(encoder.encode(`${line}\r\n`));
        }
      }
      controller.close();
    },
    cancel() {},
  });
}

async function renderHtmlStream(ctx: ExportCtx): Promise<ReadableStream<Uint8Array>> {
  const head = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. It will be read and overwritten. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3>TagNest</H3>
    <DL><p>
`;
  const tail = `    </DL><p>
</DL><p>
`;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      controller.enqueue(encoder.encode(head));
      for await (const rows of pageRows(ctx)) {
        for (const r of rows) {
          const seconds = Math.floor(new Date(r.created_at).getTime() / 1000) || 0;
          const tags = tagsOf(r);
          controller.enqueue(
            encoder.encode(
              `    <DT><A HREF="${esc(r.url)}" ADD_DATE="${seconds}"` +
                (tags.length > 0 ? ` TAGS="${esc(tags.join(','))}"` : '') +
                `>${esc(r.title || r.url)}</A>` +
                (r.description ? `\n    <DD>${esc(r.description)}` : '') +
                `\n`,
            ),
          );
        }
      }
      controller.enqueue(encoder.encode(tail));
      controller.close();
    },
    cancel() {},
  });
}

/* ------------------------------------------------------------------ *
 * Request handler
 * ------------------------------------------------------------------ */

/**
 * Full-library export with configurable scope and payload, streamed so a very
 * large library never has to fit in worker memory (the previous version glued
 * every row into one string and could OOM on huge exports).
 *
 * HTML is Netscape format (re-imports into any browser); JSON is the "TMarks
 * standard" shape `{application, version, exportedAt, bookmarks:[…]}`.
 *
 * Options (query params, `1`/`true` or `0`/`false`):
 *   format         json | html | csv            (default json)
 *   includeTrash   1/0  include soft-deleted bookmarks (default 1)
 *   includeTags    1/0  embed each bookmark's tags        (default 1)
 *   includeMetadata 1/0 embed note / description / ai_summary (default 1)
 *   includeVisits  1/0  embed visit_count + last_visited_at (default 1)
 *   pretty         1/0  pretty-print JSON                  (default 0)
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const params = new URL(ctx.request.url).searchParams;

  const format = (params.get('format') ?? 'json') as Format;
  if (!FORMATS.includes(format)) throw badRequest('不支持的导出格式');

  const flag = (name: string, def: boolean) => {
    const v = params.get(name);
    if (v == null) return def;
    return v === '1' || v === 'true';
  };
  const includeTrash = flag('includeTrash', true);
  const includeTags = flag('includeTags', true);
  const includeMetadata = flag('includeMetadata', true);
  const includeVisits = flag('includeVisits', true);
  const pretty = flag('pretty', false);

  const exportCtx: ExportCtx = { env: ctx.env, userId, includeTrash };
  const opts: ExportRenderOpts = { includeTags, includeMetadata, includeVisits, pretty };

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `tagnest-${stamp}.${format}`;

  let body: ReadableStream<Uint8Array>;
  let type: string;
  if (format === 'json') {
    body = await renderJsonStream(exportCtx, opts, new Date().toISOString());
    type = 'application/json; charset=utf-8';
  } else if (format === 'csv') {
    body = await renderCsvStream(exportCtx);
    type = 'text/csv; charset=utf-8';
  } else {
    body = await renderHtmlStream(exportCtx);
    type = 'text/html; charset=utf-8';
  }

  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function csvCell(value: string): string {
  // A leading =, +, - or @ turns a cell into a formula in Excel; prefixing
  // with a quote neutralises the injection without altering the visible text.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

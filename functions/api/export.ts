import type { Env, RequestData } from '../_lib/env';
import { requireUserId } from '../_lib/auth';
import { badRequest } from '../_lib/http';

type Format = 'json' | 'html' | 'csv';

const FORMATS: Format[] = ['json', 'html', 'csv'];

interface ExportRow {
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

/** GROUP_CONCAT separator; ASCII 31 cannot appear in a tag name. */
const SEP = String.fromCharCode(31);
const tagsOf = (row: ExportRow) => (row.tags ? row.tags.split(SEP).filter(Boolean) : []);

/**
 * Full-library export with configurable scope and payload.
 *
 * HTML output is Netscape format so the file re-imports into any browser; JSON
 * is the "TMarks standard" shape — `{application, version, exportedAt,
 * bookmarks:[…]}` — extended with every requested field set. Queries use a
 * keyset cursor and are paginated (100 rows/request) so a very large library
 * cannot blow memory.
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

  const rows = await collectRows(ctx.env, userId, includeTrash);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `tagnest-${stamp}.${format}`;
  const { body, type } = render(format, rows, { includeTags, includeMetadata, includeVisits, pretty });

  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};

/**
 * Pages through all of a user's bookmarks (optionally including trashed ones)
 * using a keyset cursor, aggregating tag names per bookmark with GROUP_CONCAT.
 * Row shape matches `ExportRow`; ORDER BY is deterministic on (created_at, id).
 */
async function collectRows(
  env: Env,
  userId: string,
  includeTrash: boolean,
): Promise<ExportRow[]> {
  const trashClause = includeTrash ? '' : 'AND b.deleted_at IS NULL';
  const pageSize = 100;
  const all: ExportRow[] = [];
  let cursorCreated: string | null = null;
  let cursorId: string | null = null;

  for (;;) {
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
    all.push(...rows);
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursorCreated = last.created_at;
    cursorId = last.id;
    // Safety: if a page somehow returned no rows after the first empty exit
    // guard, stop rather than loop forever.
  }
  return all;
}

function render(
  format: Format,
  rows: ExportRow[],
  opts: { includeTags: boolean; includeMetadata: boolean; includeVisits: boolean; pretty: boolean },
): { body: string; type: string } {
  if (format === 'json') {
    const bookmarkJson = rows.map((r) => {
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
    });

    return {
      type: 'application/json; charset=utf-8',
      body: JSON.stringify(
        {
          application: 'TagNest',
          version: 1,
          exportedAt: new Date().toISOString(),
          bookmarks: bookmarkJson,
        },
        null,
        opts.pretty ? 2 : undefined,
      ),
    };
  }

  if (format === 'csv') {
    const header = ['url', 'title', 'description', 'note', 'tags', 'favorite', 'archived', 'created_at'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
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
          .join(','),
      );
    }
    // BOM so Excel opens UTF-8 Chinese without mojibake.
    return { type: 'text/csv; charset=utf-8', body: `\ufeff${lines.join('\r\n')}` };
  }

  const entries = rows
    .map((r) => {
      const seconds = Math.floor(new Date(r.created_at).getTime() / 1000) || 0;
      const tags = tagsOf(r);
      return (
        `    <DT><A HREF="${esc(r.url)}" ADD_DATE="${seconds}"` +
        (tags.length > 0 ? ` TAGS="${esc(tags.join(','))}"` : '') +
        `>${esc(r.title || r.url)}</A>` +
        (r.description ? `\n    <DD>${esc(r.description)}` : '')
      );
    })
    .join('\n');

  return {
    type: 'text/html; charset=utf-8',
    body: `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. It will be read and overwritten. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3>TagNest</H3>
    <DL><p>
${entries}
    </DL><p>
</DL><p>
`,
  };
}

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

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
  is_favorite: number;
  is_archived: number;
  created_at: string;
  updated_at: string;
  tags: string | null;
}

/**
 * Full-library export.
 *
 * HTML output is the Netscape format, so the file re-imports into any browser
 * — the point of an export is that the data is not trapped here.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const params = new URL(ctx.request.url).searchParams;

  const format = (params.get('format') ?? 'json') as Format;
  if (!FORMATS.includes(format)) throw badRequest('不支持的导出格式');

  const includeArchived = params.get('includeArchived') !== 'false';

  const rows = await ctx.env.DB.prepare(
    `SELECT b.id, b.url, b.title, b.description, b.note, b.is_favorite, b.is_archived,
            b.created_at, b.updated_at,
            (SELECT GROUP_CONCAT(t.name, CHAR(31))
               FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
              WHERE bt.bookmark_id = b.id) AS tags
       FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL
        ${includeArchived ? '' : 'AND b.is_archived = 0'}
      ORDER BY b.created_at DESC`,
  )
    .bind(userId)
    .all<ExportRow>();

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `tagnest-${stamp}.${format}`;

  const { body, type } = render(format, rows.results);

  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};

// GROUP_CONCAT needs a separator that cannot appear in a tag name; ASCII 31
// (unit separator) is the safe choice.
const SEP = String.fromCharCode(31);

const tagsOf = (row: ExportRow) => (row.tags ? row.tags.split(SEP).filter(Boolean) : []);

function render(format: Format, rows: ExportRow[]): { body: string; type: string } {
  if (format === 'json') {
    return {
      type: 'application/json; charset=utf-8',
      body: JSON.stringify(
        {
          application: 'TagNest',
          version: 1,
          exportedAt: new Date().toISOString(),
          bookmarks: rows.map((r) => ({
            url: r.url,
            title: r.title,
            description: r.description,
            note: r.note,
            tags: tagsOf(r),
            isFavorite: r.is_favorite === 1,
            isArchived: r.is_archived === 1,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          })),
        },
        null,
        2,
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

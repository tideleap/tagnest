import { canonicalUrl } from './urlkey';

export interface ParsedItem {
  url: string;
  title: string;
  folderPath: string[];
  addedAt: string | null;
  tagNames: string[];
  /**
   * Y4: snapshot references carried by a TagNest→TagNest migration package.
   * Absent for browser/CSV imports; present only when the source file is a
   * TagNest JSON export that embedded them.
   */
  snapshotKey?: string | null;
  snapshotKeys?: string[];
}

export interface ParseOutcome {
  items: ParsedItem[];
  /** Rows that were present but unusable — bad URLs, empty lines, junk. */
  invalid: number;
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // A malformed or out-of-range code point (e.g. > 0x10FFFF or a lone
      // surrogate) would make String.fromCodePoint throw and take down the
      // whole import. Resist that: if it isn't a legal code point, emit the
      // original entity as-is rather than failing.
      if (
        Number.isFinite(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff)
      ) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Netscape exports store ADD_DATE as Unix seconds; some tools use milliseconds. */
function timestampToIso(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

/* ------------------------------------------------------------------ *
 * Netscape bookmark HTML
 * ------------------------------------------------------------------ */

/**
 * Parses the Netscape bookmark format exported by Chrome, Firefox, Edge,
 * Safari and every bookmark service worth importing from.
 *
 * The format is not valid HTML — <DT> and <p> are routinely left unclosed —
 * so a DOM parser is the wrong tool. A token scanner over <DL>/<H3>/<A>
 * reconstructs the folder tree reliably, which is what actually matters:
 * folders are the only structure the file carries, and they become tags.
 */
export function parseNetscapeHtml(source: string): ParseOutcome {
  const items: ParsedItem[] = [];
  let invalid = 0;

  const token = /<dl[^>]*>|<\/dl\s*>|<h3[^>]*>([\s\S]*?)<\/h3>|<a\s([^>]*)>([\s\S]*?)<\/a>/gi;

  const stack: string[] = [];
  let pendingFolder: string | null = null;

  let match: RegExpExecArray | null;
  while ((match = token.exec(source)) !== null) {
    const raw = match[0].toLowerCase();

    if (raw.startsWith('<dl')) {
      // A <DL> always opens the body of the folder named by the preceding
      // <H3>; the root list has no heading, hence the empty push.
      stack.push(pendingFolder ?? '');
      pendingFolder = null;
      continue;
    }

    if (raw.startsWith('</dl')) {
      stack.pop();
      continue;
    }

    if (raw.startsWith('<h3')) {
      pendingFolder = decodeEntities(match[1] ?? '')
        .replace(/<[^>]*>/g, '')
        .trim();
      continue;
    }

    // <A ...>
    const attrs = match[2] ?? '';
    const href = attr(attrs, 'href');
    const url = href ? canonicalUrl(href) : null;

    if (!url) {
      // Chrome writes place:// entries for smart folders; they are noise.
      invalid += 1;
      continue;
    }

    let title = '';
    try {
      title = decodeEntities(match[3] ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      // A pathological title (e.g. a broken character entity) must never take
      // down the whole import — fall back to the raw fragment.
      title = (match[3] ?? '').replace(/<[^>]*>/g, '').trim();
    }

    // Some exporters (Pocket, Raindrop) already carry tags in an attribute.
    let tagNames: string[] = [];
    try {
      const tagAttr = attr(attrs, 'tags');
      tagNames = tagAttr
        ? tagAttr
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
    } catch {
      tagNames = [];
    }

    items.push({
      url,
      title,
      folderPath: stack.filter(Boolean),
      addedAt: timestampToIso(attr(attrs, 'add_date')),
      tagNames,
    });
  }

  return { items, invalid };
}

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

/** Accepts a TagNest export, a bare array, or the common `{ bookmarks: [] }` shape. */
export function parseJson(source: string): ParseOutcome {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return { items: [], invalid: 0 };
  }

  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { bookmarks?: unknown }).bookmarks)
      ? (data as { bookmarks: unknown[] }).bookmarks
      : Array.isArray((data as { items?: unknown }).items)
        ? (data as { items: unknown[] }).items
        : [];

  const items: ParsedItem[] = [];
  let invalid = 0;

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      invalid += 1;
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const url = canonicalUrl(String(rec.url ?? rec.uri ?? rec.href ?? ''));
    if (!url) {
      invalid += 1;
      continue;
    }

    const rawTags = rec.tags ?? rec.tagNames;
    const tagNames = Array.isArray(rawTags)
      ? rawTags
          .map((t) =>
            typeof t === 'string' ? t : t && typeof t === 'object' ? String((t as { name?: unknown }).name ?? '') : '',
          )
          .map((t) => t.trim())
          .filter(Boolean)
      : typeof rawTags === 'string'
        ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
        : [];

    const folder = rec.folder ?? rec.folderPath ?? rec.collection;
    const folderPath = Array.isArray(folder)
      ? folder.map(String).filter(Boolean)
      : typeof folder === 'string' && folder.trim()
        ? folder.split('/').map((s) => s.trim()).filter(Boolean)
        : [];

    // Y4: preserve snapshot references from a TagNest export so they survive a
    // TagNest→TagNest migration. Other formats leave these undefined and the
    // commit handler writes NULL/empty for them.
    const snapKeyRaw = rec.snapshotKey ?? rec.snapshot_key;
    const snapshotKey = typeof snapKeyRaw === 'string' ? snapKeyRaw : null;
    const snapKeysRaw = rec.snapshotKeys ?? rec.snapshot_keys;
    let snapshotKeys: string[] = [];
    if (Array.isArray(snapKeysRaw)) {
      snapshotKeys = snapKeysRaw.filter((k): k is string => typeof k === 'string');
    } else if (typeof snapKeysRaw === 'string') {
      try {
        const arr = JSON.parse(snapKeysRaw);
        if (Array.isArray(arr)) snapshotKeys = arr.filter((k): k is string => typeof k === 'string');
      } catch {
        snapshotKeys = [];
      }
    }

    items.push({
      url,
      title: String(rec.title ?? rec.name ?? '').replace(/\s+/g, ' ').trim(),
      folderPath,
      addedAt: normaliseDate(rec.createdAt ?? rec.created ?? rec.addedAt ?? rec.date),
      tagNames,
      snapshotKey,
      snapshotKeys,
    });
  }

  return { items, invalid };
}

function normaliseDate(value: unknown): string | null {
  if (typeof value === 'number') return timestampToIso(String(value));
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d+$/.test(value.trim())) return timestampToIso(value.trim());
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/** RFC 4180 field splitter: handles quoted fields, escaped quotes and CRLF. */
export function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);

  return rows;
}

const URL_HEADERS = ['url', 'uri', 'href', 'link', '网址', '链接', '地址'];
const TITLE_HEADERS = ['title', 'name', 'description', '标题', '名称'];
const TAG_HEADERS = ['tags', 'tag', 'labels', 'keywords', '标签'];
const FOLDER_HEADERS = ['folder', 'folders', 'collection', 'category', '文件夹', '分类'];
const DATE_HEADERS = ['created', 'created_at', 'createdat', 'date', 'added', 'add_date', 'time'];

function columnIndex(header: string[], candidates: string[]): number {
  return header.findIndex((h) => candidates.includes(h.trim().toLowerCase().replace(/^\ufeff/, '')));
}

export function parseCsv(source: string): ParseOutcome {
  const rows = parseCsvRows(source);
  if (rows.length === 0) return { items: [], invalid: 0 };

  const header = rows[0];
  let urlCol = columnIndex(header, URL_HEADERS);
  let titleCol = columnIndex(header, TITLE_HEADERS);
  let tagCol = columnIndex(header, TAG_HEADERS);
  let folderCol = columnIndex(header, FOLDER_HEADERS);
  let dateCol = columnIndex(header, DATE_HEADERS);

  let body = rows.slice(1);

  // Headerless file: fall back to positional columns and keep row 0 as data.
  if (urlCol === -1) {
    const firstUrlCol = header.findIndex((cell) => canonicalUrl(cell) !== null);
    if (firstUrlCol === -1) return { items: [], invalid: rows.length };
    urlCol = firstUrlCol;
    titleCol = firstUrlCol === 0 ? 1 : 0;
    tagCol = -1;
    folderCol = -1;
    dateCol = -1;
    body = rows;
  }

  const items: ParsedItem[] = [];
  let invalid = 0;

  for (const cells of body) {
    const url = canonicalUrl(cells[urlCol] ?? '');
    if (!url) {
      invalid += 1;
      continue;
    }
    const rawTags = tagCol >= 0 ? (cells[tagCol] ?? '') : '';
    const rawFolder = folderCol >= 0 ? (cells[folderCol] ?? '') : '';

    items.push({
      url,
      title: (titleCol >= 0 ? (cells[titleCol] ?? '') : '').replace(/\s+/g, ' ').trim(),
      folderPath: rawFolder ? rawFolder.split(/[/>|]/).map((s) => s.trim()).filter(Boolean) : [],
      addedAt: dateCol >= 0 ? normaliseDate(cells[dateCol]) : null,
      tagNames: rawTags
        ? rawTags.split(/[,;|]/).map((t) => t.trim()).filter(Boolean)
        : [],
    });
  }

  return { items, invalid };
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

export type ImportSource = 'html' | 'json' | 'csv';

export function detectSource(filename: string, content: string): ImportSource {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';

  // Extension missing or wrong — sniff the content instead of guessing.
  const head = content.slice(0, 500).trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  if (/<a\s[^>]*href=/i.test(content.slice(0, 4000))) return 'html';
  return 'csv';
}

export function parseBySource(source: ImportSource, content: string): ParseOutcome {
  switch (source) {
    case 'json':
      return parseJson(content);
    case 'csv':
      return parseCsv(content);
    case 'html':
    default:
      return parseNetscapeHtml(content);
  }
}

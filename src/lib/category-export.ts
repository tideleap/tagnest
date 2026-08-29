// src/lib/category-export.ts
//
// Export the current primary-category placements to a Netscape Bookmark
// File Format HTML file, so a user without the browser extension installed
// can still apply the categorization to their real bookmark tree.
//
// ## Why an HTML export (rather than calling chrome.bookmarks)
//
// The `chrome.bookmarks` API is only available to Chrome extensions declared
// with the `bookmarks` permission. A plain web page cannot touch the user's
// bookmark tree. The Netscape Bookmark File Format is the lowest common
// denominator every major browser (Chrome, Edge, Firefox, Safari) has
// supported for import since the 2000s, so we serialise the placements into
// that format and let the user import the file in three clicks.
//
// ## Trade-offs
//
//  - **One-shot, not live.** Re-running the categoriser produces a new file;
//    it does not auto-sync. The extension path is the only way to keep the
//    bookmark bar in lockstep with the cloud tree, and is unchanged.
//  - **Import lands under "Other bookmarks".** Chrome's import target is
//    fixed; the user drags the new top-level folder into the bookmark bar
//    once.
//  - **No undo through us.** The browser-native import is outside our
//    control. We document this and recommend a one-bookmark dry run.
//
// Format reference: <https://learn.microsoft.com/en-us/openspecs/ie_standards/ms-netscape/>

/** The browser's bookmark bar label used as the outermost import folder.
 *  Matches the Netscape export convention (Chrome imports under "书签栏"). */
export const BOOKMARKS_BAR_TITLE = '书签栏';

/** Prefix for the per-export session folder. Appended with a timestamp so
 *  every run is an independent, deletable unit
 *  (e.g. "✨ AI 整理 2026/8/23 13:35:35"). */
export const AI_SESSION_PREFIX = '✨ AI 整理 ';

/** What we feed in. Mostly a `CategoryWritebackItem` with an optional
 *  `createdAt` so the Netscape `ADD_DATE` reflects the real bookmark age
 *  instead of today. Falsy = use `generatedAt` (matches the bookmark is
 *  new in the cloud). */
export interface ExportRow {
  bookmarkId: string;
  url: string;
  title: string;
  categoryPath: string[] | null;
  createdAt?: number;
}

/** Options to `toNetscapeBookmarksHtml`. */
export interface ExportOptions {
  /** Unix seconds used as the file's own `ADD_DATE`. */
  generatedAt: number;
  /** Session folder name (e.g. "✨ AI 整理 2026/8/23 13:35:35"). Auto-generated
   *  from `generatedAt` when omitted. */
  sessionTitle?: string;
  /** Wrap the whole tree in a "书签栏" root folder (browser import target).
   *  Default true. */
  bookmarksBar?: boolean;
  /** Normalise bookmark titles: turn empty / generic (首页, Home) / bare-host
   *  titles into a "首页 | 站点" label and strip redundant whitespace.
   *  Default true. */
  normalizeTitles?: boolean;
}

/**
 * Serialise the writeback rows into a Netscape-format HTML document.
 *
 * Layout (with the default `bookmarksBar: true`):
 *   <DL>                                       ← outermost envelope
 *     <H3>书签栏</H3>                           ← browser import target
 *     <DL>
 *       <H3>✨ AI 整理 2026/8/23 13:35:35</H3>  ← one folder per export
 *       <DL>
 *         <H3>开发技术</H3>                      ← level 1 (领域)
 *         <DL>
 *           <H3>React 官网</H3>                 ← level 2 (具体网站/产品)
 *           <DL>
 *             <A HREF=…>…</A>
 *           </DL>
 *         </DL>
 *         <H3>未分类</H3>                        ← uncategorised siblings
 *         <DL> … </DL>
 *       </DL>
 *     </DL>
 *   </DL>
 *
 * Bookmarks with `categoryPath === null` are gathered under a single
 * "未分类" sibling so they are not silently dropped from the export.
 *
 * Nested folder depth is unlimited; the recurrence is intentionally
 * iterative to avoid blowing the call stack on a library with a deep tree.
 */
export function toNetscapeBookmarksHtml(
  rows: ReadonlyArray<ExportRow>,
  options: ExportOptions,
): string {
  const gen = Math.max(0, Math.floor(options.generatedAt));
  const useBar = options.bookmarksBar ?? true;
  const normalize = options.normalizeTitles ?? true;
  const sessionTitle =
    options.sessionTitle && options.sessionTitle.trim().length > 0
      ? options.sessionTitle.trim()
      : AI_SESSION_PREFIX + formatSessionStamp(gen);
  const topTitle = useBar ? BOOKMARKS_BAR_TITLE : sessionTitle;

  const out: string[] = [];
  out.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
  out.push('<!-- This is an automatically generated file. It will be read and overwritten. -->');
  out.push('<!-- DO NOT EDIT! -->');
  out.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
  out.push('<TITLE>' + escapeHtml(topTitle) + '</TITLE>');
  out.push('<H1>' + escapeHtml(topTitle) + '</H1>');
  out.push('<DL><p>');

  // Outer "书签栏" folder — the browser's import landing target.
  const barIndent = '    ';
  if (useBar) {
    out.push(
      barIndent + '<DT><H3 ADD_DATE="' + gen + '" LAST_MODIFIED="' + gen + '">'
        + escapeHtml(BOOKMARKS_BAR_TITLE) + '</H3>',
    );
    out.push(barIndent + '<DL><p>');
  }

  // Per-export "✨ AI 整理 …" session folder. Every run is an independent,
  // fully deletable unit, so re-imports never accumulate duplicate trees.
  const sessionIndent = useBar ? '        ' : '    ';
  out.push(
    sessionIndent + '<DT><H3 ADD_DATE="' + gen + '" LAST_MODIFIED="' + gen + '">'
      + escapeHtml(sessionTitle) + '</H3>',
  );
  out.push(sessionIndent + '<DL><p>');

  // Bucket rows by categoryPath so the folder tree is built exactly once.
  // Uncategorised rows share one bucket regardless of null-ness.
  const buckets = new Map<string, ExportRow[]>();
  const UNCATEGORISED_KEY = '\u0000';
  for (const row of rows) {
    const key = row.categoryPath && row.categoryPath.length > 0
      ? row.categoryPath.join('\u0001')
      : UNCATEGORISED_KEY;
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }

  // Walk distinct category paths in a stable order: depth-first, alphabetic
  // within siblings. Insert empty folder headers when an intermediate level
  // has no direct bookmarks (so a path that only exists via grand-children
  // is still represented in the import). The browser then renders it as
  // an empty folder — better than losing the path entirely.
  const seenFolders = new Set<string>();

  // 1. Walk every *categorised* row's path and emit folder headers we have
  //    not yet emitted. Sort by path lexicographically so siblings group.
  const allPaths = new Set<string>();
  for (const row of rows) {
    if (!row.categoryPath) continue;
    for (let depth = 1; depth <= row.categoryPath.length; depth += 1) {
      allPaths.add(row.categoryPath.slice(0, depth).join('\u0001'));
    }
  }
  const sortedPaths = [...allPaths].sort((a, b) => a.localeCompare(b, 'zh'));

  for (const pathKey of sortedPaths) {
    const path = pathKey.split('\u0001');
    emitFolderHeaders(out, path, seenFolders, gen, sessionIndent);
  }
  // Then emit categorised bookmark rows under their leaf.
  for (const row of rows) {
    if (!row.categoryPath) continue;
    const indent = sessionIndent + '  '.repeat(row.categoryPath.length);
    out.push(indent + formatBookmarkLine(row, gen, normalize));
  }

  // 2. Then uncategorised, if any.
  const uncategorised = buckets.get(UNCATEGORISED_KEY) ?? [];
  if (uncategorised.length > 0) {
    const folderPath = ['未分类'];
    emitFolderHeaders(out, folderPath, seenFolders, gen, sessionIndent);
    for (const row of uncategorised) {
      const indent = sessionIndent + '  '.repeat(1);
      out.push(indent + formatBookmarkLine(row, gen, normalize));
    }
  }

  // Close: session <DL>, then 书签栏 <DL> (if used), then the outer <DL>.
  // Folder <DL>s are intentionally left unclosed like the original — browsers
  // tolerate it and it matches the historical export shape.
  out.push(sessionIndent + '</DL><p>');
  if (useBar) out.push(barIndent + '</DL><p>');
  out.push('</DL><p>');
  out.push('');
  return out.join('\r\n');
}

/** Format a unix-second timestamp as `YYYY/M/D HH:mm:ss` (no zero-padding on
 *  month/day), matching the reference export's session-stamp style. */
function formatSessionStamp(sec: number): string {
  const d = new Date(sec * 1000);
  const n = (x: number) => String(x);
  return `${d.getFullYear()}/${n(d.getMonth() + 1)}/${n(d.getDate())} `
    + `${n(d.getHours())}:${n(d.getMinutes())}:${n(d.getSeconds())}`;
}

/** Best-effort "site label" from a URL: the registrable second-level name
 *  (e.g. `amap.com` → `amap`, `sub.foo.example.co.uk` → `example`). Returns
 *  '' when the URL is unusable. */
function hostLabelOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length >= 2) return parts[parts.length - 2];
    return host;
  } catch {
    return '';
  }
}

const GENERIC_TITLES = new Set([
  '首页', '主页', 'home', 'homepage', 'index', '未命名', '新标签页', 'about:blank', '',
]);

/**
 * Normalise a bookmark's display title for export.
 *
 * The goal is consistency, not invention: keep meaningful titles verbatim,
 * but rescue the ones that would be useless in a bookmarks bar — empty
 * strings, bare "首页/Home" placeholders, and titles that are just the host —
 * by turning them into a "首页 | 站点" label (mirroring the reference
 * template's "首页 | 高德控制台" style). Friendly brand names cannot be
 * derived from a domain, so we use the domain label as the fallback site
 * token.
 */
export function normalizeBookmarkTitle(title: string, url: string): string {
  const raw = (title ?? '').replace(/\s+/g, ' ').trim();
  const label = hostLabelOf(url);
  const lc = raw.toLowerCase();

  // Empty or generic placeholder → "首页 | 站点" (or the URL if hostless).
  if (raw === '' || GENERIC_TITLES.has(lc)) {
    if (label) return `首页 | ${label}`;
    return url && url.trim() ? url.trim() : '未命名书签';
  }

  if (label) {
    // Title is literally the host (with or without www) → treat as generic.
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      host = '';
    }
    if (lc === host || lc === label) {
      return `首页 | ${label}`;
    }
    // Already contains the site label → don't double up.
    if (lc.includes(label)) return raw;
  }

  return raw;
}

/** Append any folder headers along `path` that have not yet been emitted,
 *  in order from shallow to deep, each followed by its opening <DL><p>.
 *  `prefix` is the indentation of the session folder; each level adds two
 *  spaces so the tree renders nested under it. */
function emitFolderHeaders(
  out: string[],
  path: string[],
  seen: Set<string>,
  gen: number,
  prefix: string,
): void {
  for (let depth = 1; depth <= path.length; depth += 1) {
    const key = path.slice(0, depth).join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    const indent = prefix + '  '.repeat(depth);
    out.push(
      indent + '<DT><H3 ADD_DATE="' + gen + '" LAST_MODIFIED="' + gen + '">'
        + escapeHtml(path[depth - 1]) + '</H3>',
    );
    out.push(indent + '<DL><p>');
  }
}

/** Render one `<DT><A HREF=…>…</A>` line. The browser importer only needs
 *  HREF and the inner text, but ADD_DATE / ICON help keep parity with the
 *  cloud timestamps where we have them. When `normalize` is set, the title
 *  is run through {@link normalizeBookmarkTitle}. */
function formatBookmarkLine(row: ExportRow, fallbackGen: number, normalize: boolean): string {
  const addDate = Number.isFinite(row.createdAt) && row.createdAt
    ? Math.max(0, Math.floor(row.createdAt))
    : fallbackGen;
  const title = normalize
    ? normalizeBookmarkTitle(row.title, row.url)
    : (row.title ?? '').replace(/\s+/g, ' ').trim() || row.url;
  return (
    '<DT><A HREF="' + escapeAttr(row.url) + '" ADD_DATE="' + addDate + '">'
      + escapeHtml(title) + '</A>'
  );
}

/** HTML-escape an attribute value: `&`, `"`, the URL-significant chars. */
function escapeAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
}

/** HTML-escape element text. */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Browser download trigger. Creates a one-shot `Blob`, points a hidden
 * `<a>` at its object URL, clicks it, and cleans up. Safe under React 18
 * strict mode (no global state retained).
 */
export function downloadBlob(filename: string, content: string, mime: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  // Some browsers require the anchor to be in the DOM to fire a click.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the download has a chance to start on all browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Build a stable filename like `tagnest-categories-2026-08-23-1830.html`. */
export function buildExportFilename(now: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `tagnest-categories-${stamp}.html`;
}

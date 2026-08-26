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

/** The literal root title that wraps every export. Users rename it freely
 *  on import; we keep it stable so two exports of the same library are
 *  obvious to the eye. */
export const EXPORT_ROOT_TITLE = 'TagNest 分类';

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
  /** Root folder title. Defaults to `EXPORT_ROOT_TITLE`. */
  rootTitle?: string;
}

/**
 * Serialise the writeback rows into a Netscape-format HTML document.
 *
 * Layout:
 *   <DL>
 *     <H3>Level 1</H3>
 *     <DL>
 *       <H3>Level 2</H3>
 *       <DL>
 *         <A HREF=…>Title</A>
 *       </DL>
 *     </DL>
 *     <H3>Level 1 (uncategorised bookmarks go here, in an "未分类" H3)</H3>
 *     <DL>
 *       <A HREF=…>…</A>
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
  const rootTitle = options.rootTitle ?? EXPORT_ROOT_TITLE;
  const gen = Math.max(0, Math.floor(options.generatedAt));

  const out: string[] = [];
  out.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
  out.push('<!-- This is an automatically generated file. It will be read and overwritten. -->');
  out.push('<!-- DO NOT EDIT! -->');
  out.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
  out.push('<TITLE>' + escapeHtml(rootTitle) + '</TITLE>');
  out.push('<H1>' + escapeHtml(rootTitle) + '</H1>');
  out.push('<DL><p>');
  // Root folder entry; the user-visible tree starts here on import.
  out.push(
    '    <DT><H3 ADD_DATE="' + gen + '" LAST_MODIFIED="' + gen + '">'
      + escapeHtml(rootTitle) + '</H3>',
  );
  out.push('    <DL><p>');

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
    emitFolderHeaders(out, path, seenFolders, gen, 2);
  }
  // Then emit categorised bookmark rows under their leaf.
  for (const row of rows) {
    if (!row.categoryPath) continue;
    // Indent: 2 spaces (under root) + path.length * 2.
    const indent = '    ' + '  '.repeat(row.categoryPath.length);
    out.push(indent + formatBookmarkLine(row, gen));
  }

  // 2. Then uncategorised, if any.
  const uncategorised = buckets.get(UNCATEGORISED_KEY) ?? [];
  if (uncategorised.length > 0) {
    const folderPath = ['未分类'];
    emitFolderHeaders(out, folderPath, seenFolders, gen, 2);
    for (const row of uncategorised) {
      out.push('      ' + formatBookmarkLine(row, gen));
    }
  }

  // Close: the root <DL><p>, then the outer <DL><p>, then </BODY></HTML> for
  // HTML5-compliant parsers (browsers tolerate the omission, but some
  // bookmark importers are strict).
  out.push('    </DL><p>'); // end of root folder
  out.push('</DL><p>');
  out.push('');
  return out.join('\r\n');
}

/** Append any folder headers along `path` that have not yet been emitted,
 *  in order from shallow to deep, each followed by its opening <DL><p>. */
function emitFolderHeaders(
  out: string[],
  path: string[],
  seen: Set<string>,
  gen: number,
  baseIndent: number,
): void {
  for (let depth = 1; depth <= path.length; depth += 1) {
    const key = path.slice(0, depth).join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    const indent = ' '.repeat(baseIndent + (depth - 1) * 2);
    out.push(
      indent + '<DT><H3 ADD_DATE="' + gen + '" LAST_MODIFIED="' + gen + '">'
        + escapeHtml(path[depth - 1]) + '</H3>',
    );
    out.push(indent + '<DL><p>');
  }
}

/** Render one `<DT><A HREF=…>…</A>` line. The browser importer only needs
 *  HREF and the inner text, but ADD_DATE / ICON help keep parity with the
 *  cloud timestamps where we have them. */
function formatBookmarkLine(row: ExportRow, fallbackGen: number): string {
  const addDate = Number.isFinite(row.createdAt) && row.createdAt
    ? Math.max(0, Math.floor(row.createdAt))
    : fallbackGen;
  return (
    '<DT><A HREF="' + escapeAttr(row.url) + '" ADD_DATE="' + addDate + '">'
      + escapeHtml(row.title || row.url) + '</A>'
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

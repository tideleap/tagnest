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
//
// ## Structure (decided 2026-08-29: 3-level taxonomy)
//
//   书签栏 (PERSONAL_TOOLBAR_FOLDER="true")      ← browser import target
//     └─ ✨ AI 整理 <timestamp>                    ← one folder per export
//          └─ <L1 领域>                            ← e.g. 开发与运维
//               └─ <L2 子类别>                      ← e.g. 开发工具
//                    └─ <L3 站点>                    ← e.g. React / 高德地图
//                         └─ <A HREF …>书签</A>
//
// Category depth is fixed at three levels (领域 › 子类别 › 站点). Folders are
// ordered by bookmark count (desc) then pinyin (asc); bookmarks inside a folder
// are ordered by title pinyin (asc). The friendly site name for the title
// fallback reuses the shared `canonicalSiteLabel` so the exporter, the AI
// engine and the rename track all agree on the same brand name.

/** The browser's bookmark bar label used as the outermost import folder.
 *  Matches the Netscape export convention (Chrome imports under "书签栏"). */
export const BOOKMARKS_BAR_TITLE = '书签栏';

/** Prefix for the per-export session folder. Appended with a timestamp so
 *  every run is an independent, deletable unit
 *  (e.g. "✨ AI 整理 2026/8/23 13:35:35"). */
export const AI_SESSION_PREFIX = '✨ AI 整理 ';

/** Category depth the export enforces: 领域 › 子类别 › 站点 (3 levels).
 *  Must stay in sync with the product decision (see docs/ai-content-organize-review.md). */
const MAX_EXPORT_CATEGORY_DEPTH = 3;

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

import { canonicalSiteLabel, isGenericTitle } from '@shared/siteLabel';

/** A node in the export folder tree; counts are subtree totals. */
interface FolderNode {
  name: string;
  count: number;
  children: Map<string, FolderNode>;
  bookmarks: ExportRow[];
}

/**
 * Serialise the writeback rows into a Netscape-format HTML document.
 *
 * Layout (with the default `bookmarksBar: true`):
 *   <DL>                                       ← outermost envelope
 *     <H3 PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>   ← browser import target
 *     <DL>
 *       <H3>✨ AI 整理 2026/8/23 13:35:35</H3>  ← one folder per export
 *       <DL>
 *         <H3>开发技术</H3>                      ← level 1 (领域)
 *         <DL>
 *           <H3>前端开发</H3>                    ← level 2 (子类别)
 *           <DL>
 *             <H3>React</H3>                    ← level 3 (站点)
 *             <DL>
 *               <A HREF=…>…</A>
 *             </DL>
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
 * Nested folder depth is unlimited in the input but clamped to
 * `MAX_EXPORT_CATEGORY_DEPTH` so the output always matches the decided 3-level
 * taxonomy. The recurrence is intentionally iterative to avoid blowing the call
 * stack on a library with a deep tree.
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
  // Per the reference template it must carry PERSONAL_TOOLBAR_FOLDER="true".
  const barIndent = '    ';
  if (useBar) {
    out.push(
      barIndent + '<DT><H3 ADD_DATE="' + gen + '" LAST_MODIFIED="' + gen
        + '" PERSONAL_TOOLBAR_FOLDER="true">'
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

  // --- Build the folder tree -------------------------------------------
  // Counts are subtree totals so siblings sort by their *whole* bucket, not
  // just their direct bookmarks. The tree is then emitted depth-first with
  // deterministic ordering (count desc, pinyin tiebreak).
  const root: FolderNode = { name: '', count: 0, children: new Map(), bookmarks: [] };
  const uncategorised: ExportRow[] = [];

  for (const row of rows) {
    const path =
      row.categoryPath && row.categoryPath.length > 0
        ? row.categoryPath.slice(0, MAX_EXPORT_CATEGORY_DEPTH)
        : null;
    if (!path) {
      uncategorised.push(row);
      continue;
    }
    root.count += 1;
    let node = root;
    for (const seg of path) {
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, count: 0, children: new Map(), bookmarks: [] };
        node.children.set(seg, child);
      }
      child.count += 1;
      node = child;
    }
    node.bookmarks.push(row);
  }

  if (uncategorised.length > 0) {
    root.children.set('未分类', {
      name: '未分类',
      count: uncategorised.length,
      children: new Map(),
      bookmarks: uncategorised,
    });
  }

  emitNode(out, root, sessionIndent, gen, normalize);

  // Close: session <DL>, then 书签栏 <DL> (if used), then the outer <DL>.
  // Folder <DL>s are intentionally left unclosed like the original — browsers
  // tolerate it and it matches the historical export shape.
  out.push(sessionIndent + '</DL><p>');
  if (useBar) out.push(barIndent + '</DL><p>');
  out.push('</DL><p>');
  out.push('');
  return out.join('\r\n');
}

/** Recursively emit one folder node's children (sorted) then its own bookmarks
 *  (sorted). `indent` is the indentation already applied to this node's own
 *  `<H3>`; children get two extra spaces. */
function emitNode(
  out: string[],
  node: FolderNode,
  indent: string,
  gen: number,
  normalize: boolean,
): void {
  const children = [...node.children.values()].sort(byCountThenPinyin);
  for (const child of children) {
    const childIndent = indent + '  ';
    out.push(
      childIndent + '<DT><H3 ADD_DATE="' + gen + '" LAST_MODIFIED="' + gen + '">'
        + escapeHtml(child.name) + '</H3>',
    );
    out.push(childIndent + '<DL><p>');
    emitNode(out, child, childIndent, gen, normalize);
  }

  const sortedBookmarks = node.bookmarks
    .slice()
    .sort((a, b) =>
      pinyinCompare(bookmarkSortKey(a, normalize), bookmarkSortKey(b, normalize)),
    );
  for (const row of sortedBookmarks) {
    const bIndent = indent + '  ';
    out.push(bIndent + formatBookmarkLine(row, gen, normalize));
  }
}

/** Sibling folders: most bookmarks first, pinyin as deterministic tiebreak. */
function byCountThenPinyin(a: { name: string; count: number }, b: { name: string; count: number }): number {
  return b.count - a.count || pinyinCompare(a.name, b.name);
}

/** Pinyin-aware comparison that approximates Chinese reading order (zh-Hans-CN). */
function pinyinCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN');
}

/** Display key used to order a bookmark within its folder. */
function bookmarkSortKey(row: ExportRow, normalize: boolean): string {
  return normalize
    ? normalizeBookmarkTitle(row.title, row.url)
    : ((row.title ?? '').replace(/\s+/g, ' ').trim() || row.url || '');
}

/** Format a unix-second timestamp as `YYYY/M/D HH:mm:ss` (no zero-padding on
 *  month/day), matching the reference export's session-stamp style. */
function formatSessionStamp(sec: number): string {
  const d = new Date(sec * 1000);
  const n = (x: number) => String(x);
  return `${d.getFullYear()}/${n(d.getMonth() + 1)}/${n(d.getDate())} `
    + `${n(d.getHours())}:${n(d.getMinutes())}:${n(d.getSeconds())}`;
}

/** Best-effort registrable host of a URL (lowercased, www. stripped). */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Registrable second-level label of a host
 *  (e.g. `amap.com` → `amap`, `sub.foo.example.co.uk` → `example`). */
function hostLabelOf(url: string): string {
  const host = safeHost(url);
  if (!host) return '';
  const parts = host.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : host;
}

/**
 * Normalise a bookmark's display title for export.
 *
 * The goal is consistency, not invention: keep meaningful titles verbatim,
 * but rescue the ones that would be useless in a bookmarks bar — empty
 * strings, bare "首页/Home" placeholders, and titles that are just the host —
 * by turning them into a "首页 | 友好品牌名" label (mirroring the reference
 * template's "首页 | 高德地图" style). The friendly brand name comes from the
 * shared `canonicalSiteLabel` resolver, so it is identical to what the AI
 * engine assigns as an L2 site folder.
 */
export function normalizeBookmarkTitle(title: string, url: string): string {
  const raw = (title ?? '').replace(/\s+/g, ' ').trim();
  const lc = raw.toLowerCase();

  // Empty or generic placeholder → "首页 | 友好品牌名" (or the URL if hostless).
  if (raw === '' || isGenericTitle(lc)) {
    const brand = canonicalSiteLabel(url);
    if (brand && brand !== '未命名站点') return `首页 | ${brand}`;
    return url && url.trim() ? url.trim() : '未命名书签';
  }

  const host = safeHost(url);
  if (host) {
    const label = hostLabelOf(url);
    // Title is literally the host (with or without www) → treat as generic.
    if (lc === host || lc === label) {
      return `首页 | ${canonicalSiteLabel(url)}`;
    }
    // Already contains the site label → don't double up.
    if (label && lc.includes(label)) return raw;
  }

  return raw;
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

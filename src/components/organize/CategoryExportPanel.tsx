// src/components/organize/CategoryExportPanel.tsx
//
// Web-side "apply categories to the bookmark bar" path.
//
// The browser extension can talk to `chrome.bookmarks` directly and keep
// the bookmark bar in lockstep with the cloud tree (see
// `extension/category.html`). A plain web page cannot. For users without
// the extension (or on a browser where the extension is not yet packaged)
// this panel offers the fallback: serialise the current primary-category
// placements to a Netscape Bookmark File Format HTML and download it. The
// user imports it in three clicks (chrome://bookmarks → ⋮ → Import).
//
// ## What this is not
//
//  - **Not a live sync.** Re-running the categoriser produces a new file;
//    it does not auto-update the bookmark bar.
//  - **Not an undo path.** The browser-native import is outside our
//    control; we surface this honestly in the copy below.
//
// Kept deliberately small and pure: the only IO is the existing
// `useCategoryWriteback` infinite query (already in cache for users who
// have just finished a categorise run).

import { useState } from 'react';
import { Download, ExternalLink, FileDown } from 'lucide-react';
import { Button } from '@/components/ui';
import { useCategoryWriteback } from '@/hooks/queries/category';
import {
  toNetscapeBookmarksHtml,
  buildExportFilename,
  downloadBlob,
  type ExportRow,
} from '@/lib/category-export';

/**
 * Renders the "Export current categories to bookmarks.html" panel. Only
 * meaningful in the categorize track; mount conditionally in OrganizePage.
 */
export function CategoryExportPanel() {
  const writeback = useCategoryWriteback();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Walk all cached pages; the infinite query has already fetched every
  // page it has seen, so we use the cached data instead of triggering a
  // fresh network round-trip. If the user is on a fresh load, `fetchNextPage`
  // is called until exhausted.
  const ensureAllPages = async (): Promise<void> => {
    if (writeback.isFetching || writeback.isFetchingNextPage) return;
    while (writeback.hasNextPage) {
      await writeback.fetchNextPage();
    }
  };

  const onExport = async () => {
    setError(null);
    setBusy(true);
    try {
      await ensureAllPages();
      const items = (writeback.data?.pages ?? []).flatMap((p) => p.items);
      if (items.length === 0) {
        setError('当前还没有可导出的分类结果——先运行一次「开始分类」再回来。');
        return;
      }
      const rows: ExportRow[] = items.map((it) => ({
        bookmarkId: it.bookmarkId,
        url: it.url,
        title: it.title,
        categoryPath: it.categoryPath,
      }));
      const html = toNetscapeBookmarksHtml(rows, {
        generatedAt: Math.floor(Date.now() / 1000),
      });
      downloadBlob(buildExportFilename(), html, 'text/html');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const totalRows = writeback.data?.pages?.[0]?.total ?? 0;

  return (
    <section className="spotlight flex flex-col gap-3 rounded-xl border border-line bg-surface/85 p-5 shadow-raised backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileDown size={17} className="shrink-0 text-brand-accent" aria-hidden />
          <h2 className="font-display text-[0.95rem] font-semibold tracking-tight text-ink">
            把分类导出到浏览器书签栏
          </h2>
        </div>
        <Button
          size="sm"
          variant="primary"
          iconLeft={<Download size={15} />}
          onClick={() => void onExport()}
          disabled={busy || writeback.isLoading}
        >
          {busy ? '正在生成…' : '下载 bookmarks.html'}
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-ink-soft">
        当前{totalRows > 0 ? `已分类 ${totalRows}` : '已分类'}条书签会生成一份标准的浏览器书签文件。导入浏览器后即可在书签栏看到分类文件夹，不需要安装 TagNest 扩展。
      </p>

      <ol className="flex flex-col gap-1.5 text-2xs leading-relaxed text-ink-faint">
        <li>
          <span className="mr-1 font-mono text-ink-soft">1.</span>
          点击上方按钮下载 <code className="rounded bg-sunken px-1 py-px text-2xs">tagnest-categories-*.html</code>
        </li>
        <li>
          <span className="mr-1 font-mono text-ink-soft">2.</span>
          打开 <code className="rounded bg-sunken px-1 py-px text-2xs">chrome://bookmarks/</code>（或 Edge / Firefox 同等入口）→ 右上角 <span className="font-medium text-ink-soft">⋮</span> → <span className="font-medium text-ink-soft">导入书签</span> → 选刚下载的 HTML
        </li>
        <li>
          <span className="mr-1 font-mono text-ink-soft">3.</span>
          导入会落到「其他书签」根；从那里把 <span className="font-medium text-ink-soft">TagNest 分类</span> 文件夹拖到「书签栏」即可
        </li>
      </ol>

      <p className="flex items-center gap-1.5 text-2xs text-ink-faint">
        <ExternalLink size={11} aria-hidden />
        提示：重复导入会在「其他书签」里累积同名文件夹，导入前可先手动删除旧版本
      </p>

      {error && (
        <p className="rounded-md bg-critical-soft px-3 py-2 text-xs text-critical-ink">{error}</p>
      )}
    </section>
  );
}

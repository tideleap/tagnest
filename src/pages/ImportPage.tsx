import { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  FileUp,
  Table,
  Upload,
} from 'lucide-react';
import type { ImportPreview } from '@shared/types';
import { Badge, Button, Checkbox, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { TagPicker } from '@/components/bookmark/TagPicker';
import { toast } from '@/components/ui/Toast';
import { useImportCommit, useImportPreview, useStats } from '@/hooks/queries';
import { displayHost } from '@/lib/url';
import { downloadBlob } from '@/lib/api';
import { cx } from '@/lib/cx';

const ACCEPTED = '.html,.htm,.json,.csv';
const MAX_BYTES = 20 * 1024 * 1024;

export function ImportPage() {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [foldersAsTags, setFoldersAsTags] = useState(true);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [extraTags, setExtraTags] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const previewMutation = useImportPreview();
  const commitMutation = useImportCommit();
  const { data: stats } = useStats();

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error('文件过大', '请上传 20 MB 以内的文件');
      return;
    }
    previewMutation.mutate(file, { onSuccess: setPreview });
  };

  const commit = () => {
    if (!preview) return;
    commitMutation.mutate(
      {
        token: preview.token,
        foldersAsTags,
        skipDuplicates,
        extraTagNames: extraTags.length > 0 ? extraTags : undefined,
      },
      {
        onSuccess: () => {
          setPreview(null);
          setExtraTags([]);
        },
      },
    );
  };

  const willImport = preview ? preview.total - (skipDuplicates ? preview.duplicates : 0) : 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        icon={<Download size={14} aria-hidden />}
        eyebrow="数据进出"
        title="导入与导出"
        description="支持浏览器书签（HTML）、TagNest 备份（JSON）和表格（CSV）。"
      />

      {!preview ? (
        <>
          <section
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFile(e.dataTransfer.files[0]);
            }}
            className={cx(
              'rounded-lg border-2 border-dashed p-8 text-center transition-colors',
              dragging ? 'border-brand bg-brand-soft' : 'border-line bg-surface',
            )}
          >
            {previewMutation.isPending ? (
              <div className="flex flex-col items-center gap-3 text-ink-soft">
                <Spinner size={24} />
                <p className="text-sm">正在解析文件…</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sunken text-ink-faint">
                  <Upload size={22} />
                </span>
                <div>
                  <p className="text-sm font-medium text-ink">把书签文件拖到这里</p>
                  <p className="mt-1 text-xs text-ink-soft">或者点击下方按钮选择文件</p>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept={ACCEPTED}
                  className="sr-only"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                />
                <Button
                  variant="primary"
                  iconLeft={<FileUp size={16} />}
                  onClick={() => fileRef.current?.click()}
                >
                  选择文件
                </Button>
                <p className="text-2xs text-ink-faint">
                  支持 .html / .json / .csv，单个文件最大 10 MB
                </p>
              </div>
            )}
          </section>

          <section className="rounded-md border border-line bg-surface p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink">怎么导出浏览器书签？</h2>
            <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-ink-soft">
              <li>
                <strong className="font-medium text-ink">Chrome / Edge：</strong>
                书签管理器 → 右上角三点 → 导出书签
              </li>
              <li>
                <strong className="font-medium text-ink">Firefox：</strong>
                书签管理 → 导入和备份 → 导出书签到 HTML
              </li>
              <li>
                <strong className="font-medium text-ink">Safari：</strong>
                文件 → 导出 → 书签
              </li>
            </ul>
          </section>

          <ExportSection total={stats?.bookmarks ?? 0} />
        </>
      ) : (
        <section className="flex flex-col gap-4">
          <div className="rounded-md border border-line bg-surface p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="flex-1 text-sm font-semibold text-ink">解析结果</h2>
              <Badge tone="neutral">
                {preview.source === 'html' ? (
                  <FileUp size={11} />
                ) : preview.source === 'json' ? (
                  <FileJson size={11} />
                ) : (
                  <Table size={11} />
                )}
                {preview.source.toUpperCase()}
              </Badge>
            </div>

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="共解析" value={preview.total} />
              <Stat label="重复" value={preview.duplicates} tone="caution" />
              <Stat label="无效" value={preview.invalid} tone="critical" />
              <Stat label="文件夹" value={preview.folders.length} />
            </dl>
          </div>

          <div className="flex flex-col gap-3.5 rounded-md border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold text-ink">导入选项</h2>

            <Checkbox
              checked={foldersAsTags}
              onChange={(e) => setFoldersAsTags(e.target.checked)}
              label="把文件夹转成标签"
              hint={
                preview.folders.length > 0
                  ? `会创建 ${preview.folders.length} 个标签，例如：${preview.folders.slice(0, 3).join('、')}`
                  : '这个文件里没有文件夹结构'
              }
              disabled={preview.folders.length === 0}
            />

            <Checkbox
              checked={skipDuplicates}
              onChange={(e) => setSkipDuplicates(e.target.checked)}
              label="跳过已存在的链接"
              hint={`当前有 ${preview.duplicates} 条与库中已有书签重复`}
            />

            <TagPicker
              value={extraTags}
              onChange={setExtraTags}
              label="为所有导入项附加标签"
              hint="可选。方便之后一次性找到这批书签。"
            />
          </div>

          <div className="rounded-md border border-line bg-surface p-4">
            <h2 className="mb-2.5 text-sm font-semibold text-ink">
              预览
              <span className="ml-1.5 font-normal text-ink-faint">
                前 {preview.sample.length} 条
              </span>
            </h2>
            <ul className="scrollbar-slim max-h-64 overflow-y-auto">
              {preview.sample.map((item, i) => (
                <li
                  key={`${item.url}-${i}`}
                  className="flex items-center gap-2.5 border-b border-line py-2 last:border-0"
                >
                  {item.duplicate ? (
                    <AlertTriangle size={14} className="shrink-0 text-caution" aria-label="重复" />
                  ) : (
                    <CheckCircle2 size={14} className="shrink-0 text-positive" aria-label="新增" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-ink">{item.title}</p>
                    <p className="truncate text-2xs text-ink-faint">{displayHost(item.url)}</p>
                  </div>
                  {item.folderPath.length > 0 && (
                    <span className="shrink-0 text-2xs text-ink-faint">
                      {item.folderPath.join(' / ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {commitMutation.isPending && commitMutation.progress && (
            <div className="rounded-md border border-line bg-surface p-4">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold text-ink">正在导入…</h2>
                <span className="text-xs tabular-nums text-ink-soft">
                  {commitMutation.progress.done} / {commitMutation.progress.total || '…'}
                </span>
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={commitMutation.progress.total || 100}
                aria-valuenow={Math.min(commitMutation.progress.done, commitMutation.progress.total || 100)}
                aria-label="导入进度"
                className="h-2 w-full overflow-hidden rounded-full bg-sunken"
              >
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-200 ease-out"
                  style={{
                    width: `${
                      commitMutation.progress.total > 0
                        ? Math.min(100, (commitMutation.progress.done / commitMutation.progress.total) * 100)
                        : 100
                    }%`,
                  }}
                />
              </div>
              <div className="mt-2 flex gap-3 text-2xs text-ink-faint">
                {commitMutation.progress.skipped > 0 && <span>跳过 {commitMutation.progress.skipped}</span>}
                {commitMutation.progress.failed > 0 && (
                  <span className="text-critical">失败 {commitMutation.progress.failed}</span>
                )}
              </div>
            </div>
          )}

          <div className="pad-safe-b sticky bottom-0 flex items-center gap-2 border-t border-line bg-canvas py-3">
            <p className="flex-1 text-xs text-ink-soft">
              将导入 <strong className="tabular-nums text-ink">{willImport}</strong> 条书签
            </p>
            <Button variant="ghost" onClick={() => setPreview(null)} disabled={commitMutation.isPending}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={commit}
              loading={commitMutation.isPending}
              disabled={willImport === 0}
            >
              开始导入
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'caution' | 'critical';
}) {
  return (
    <div className="rounded-md bg-sunken px-3 py-2.5">
      <dt className="text-2xs text-ink-faint">{label}</dt>
      <dd
        className={cx(
          'mt-0.5 text-lg font-semibold tabular-nums',
          tone === 'caution' && value > 0 && 'text-caution-ink',
          tone === 'critical' && value > 0 && 'text-critical-ink',
          !tone && 'text-ink',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function ExportSection({ total }: { total: number }) {
  const [busy, setBusy] = useState<'json' | 'html' | 'csv' | null>(null);

  const download = async (format: 'json' | 'html' | 'csv') => {
    setBusy(format);
    try {
      const { blob, filename } = await downloadBlob(`/export?format=${format}`);

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename ?? `tagnest-${new Date().toISOString().slice(0, 10)}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('导出完成');
    } catch (err) {
      toast.error('导出失败', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (total === 0) {
    return (
      <section className="rounded-md border border-line bg-surface">
        <EmptyState
          compact
          icon={<Download size={20} />}
          title="还没有可导出的书签"
          description="导入或添加书签之后再回来。"
        />
      </section>
    );
  }

  return (
    <section className="rounded-md border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">导出</h2>
      <p className="mt-1 text-xs text-ink-soft">
        数据是你的。随时可以完整导出 {total} 条书签，不锁定在这里。
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          iconLeft={<FileJson size={15} />}
          loading={busy === 'json'}
          onClick={() => void download('json')}
        >
          JSON 完整备份
        </Button>
        <Button
          size="sm"
          iconLeft={<FileUp size={15} />}
          loading={busy === 'html'}
          onClick={() => void download('html')}
        >
          HTML 浏览器格式
        </Button>
        <Button
          size="sm"
          iconLeft={<Table size={15} />}
          loading={busy === 'csv'}
          onClick={() => void download('csv')}
        >
          CSV 表格
        </Button>
      </div>
    </section>
  );
}

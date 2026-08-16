import { useState } from 'react';
import { Download, HardDrive, ShieldCheck } from 'lucide-react';
import { Button, Checkbox, ConfirmDialog, Select, Skeleton } from '@/components/ui';
import { downloadBlob } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import {
  useCleanupSnapshots,
  useExportPreview,
  useStorageUsage,
} from '@/hooks/queries';
import { Card } from './Card';

const EXPORT_FORMAT_OPTIONS = [
  { value: 'json', label: 'TagNest JSON 格式（推荐）' },
  { value: 'html', label: 'HTML 书签（Netscape）' },
  { value: 'csv', label: 'CSV 表格' },
];

type ExportFormat = 'json' | 'html' | 'csv';

/**
 * R2 storage management: usage footprint, full JSON export, and snapshot
 * maintenance (clean up orphan snapshot records whose R2 object no longer
 * exists). Mirrors the Section pattern used by SnapshotsSection/ApiKeysSection.
 */
export function StorageSection() {
  const usage = useStorageUsage();
  const preview = useExportPreview();

  const [format, setFormat] = useState<ExportFormat>('json');
  const [includeTrash, setIncludeTrash] = useState(true);
  const [includeTags, setIncludeTags] = useState(true);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [pretty, setPretty] = useState(false);
  const [includeVisits, setIncludeVisits] = useState(true);
  const [busy, setBusy] = useState(false);

  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const cleanup = useCleanupSnapshots();

  const startExport = async () => {
    setBusy(true);
    try {
      const qs = new URLSearchParams();
      qs.set('format', format);
      qs.set('includeTrash', includeTrash ? '1' : '0');
      qs.set('includeTags', includeTags ? '1' : '0');
      qs.set('includeMetadata', includeMetadata ? '1' : '0');
      qs.set('includeVisits', includeVisits ? '1' : '0');
      qs.set('pretty', pretty ? '1' : '0');

      const { blob, filename } = await downloadBlob(`/export?${qs.toString()}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename ?? `tagnest-${new Date().toISOString().slice(0, 10)}.${format}`;
      anchor.click();
      // Defer revocation: revoking synchronously can abort the download on Safari.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('导出完成');
    } catch (err) {
      toast.error('导出失败', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clean = () => {
    setShowCleanupConfirm(false);
    // mutate (not mutateAsync): the hook's onError already toasts failures,
    // and awaiting mutateAsync here would surface an unhandled rejection.
    cleanup.mutate();
  };

  return (
    <>
      {/* R2 存储使用情况 */}
      <Card
        title="存储用量"
        description="所有快照和封面图在 R2 中的占用空间。封面图为远程地址，因此统计的是快照对象。"
      >
        {usage.isLoading || !usage.data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex items-center gap-3 rounded-md border border-line bg-sunken px-4 py-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand-ink">
              <HardDrive size={18} aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{usage.data.display}</p>
              <p className="text-xs text-ink-faint">
                {usage.data.snapshotCount} 个快照对象 · 共占用 {usage.data.snapshotFmt}
              </p>
            </div>
            <BadgePill>{`${usage.data.quotaFmt}`}</BadgePill>
          </div>
        )}
      </Card>

      {/* 导出数据 */}
      <Card title="导出数据" description="导出 JSON 备份用于迁移与归档。">
        {preview.isLoading || !preview.data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-ink-soft">
              <PreviewStat label="书签" value={String(preview.data.allCount)} />
              <PreviewStat label="回收站" value={String(preview.data.trashCount)} />
              <PreviewStat label="标签" value={String(preview.data.tagCount)} />
              <PreviewStat label="含快照" value={String(preview.data.snapshotCount)} />
            </div>
            <div className="mt-4 h-px bg-line" />
            <div className="mt-4 grid gap-x-6 gap-y-4 md:grid-cols-2">
              <Select
                label="导出格式"
                value={format}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
                options={EXPORT_FORMAT_OPTIONS}
              />
              <div className="flex flex-col gap-2.5">
                <Checkbox
                  checked={includeTrash}
                  onChange={(e) => setIncludeTrash(e.target.checked)}
                  label="包含回收站（已删除内容）"
                />
                <Checkbox
                  checked={includeTags}
                  onChange={(e) => setIncludeTags(e.target.checked)}
                  label="包含标签信息"
                />
                <Checkbox
                  checked={includeMetadata}
                  onChange={(e) => setIncludeMetadata(e.target.checked)}
                  label="包含元数据"
                />
                <Checkbox
                  checked={includeVisits}
                  onChange={(e) => setIncludeVisits(e.target.checked)}
                  label="包含点击统计"
                />
                <Checkbox
                  checked={pretty}
                  onChange={(e) => setPretty(e.target.checked)}
                  label="格式化 JSON（便于阅读）"
                />
              </div>
            </div>
          </>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            iconLeft={<Download size={15} />}
            onClick={startExport}
            loading={busy}
            disabled={preview.data ? preview.data.allCount === 0 : false}
          >
            开始导出
          </Button>
        </div>
      </Card>

      {/* 快照管理 */}
      <Card
        title="快照维护"
        description="清理和维护书签快照数据，移除引用了但不存在的孤立快照记录。"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            iconLeft={<ShieldCheck size={15} />}
            onClick={() => setShowCleanupConfirm(true)}
            loading={cleanup.isPending}
          >
            清理孤立快照记录
          </Button>
          {cleanup.data && cleanup.data.droppedKeys > 0 && (
            <span className="text-xs text-ink-soft">
              已移除 {cleanup.data.droppedKeys} 条孤立记录（{cleanup.data.dropped.length} 条详情）
            </span>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          检查所有快照记录并验证对应 R2 文件是否真实存在；仅清理无效记录，不会删除任何有效快照。
        </p>
      </Card>

      <ConfirmDialog
        open={showCleanupConfirm}
        onClose={() => setShowCleanupConfirm(false)}
        onConfirm={clean}
        loading={cleanup.isPending}
        title="清理孤立快照记录"
        confirmLabel="清理"
        tone="danger"
        message="将检查所有书签的快照记录并移除对应 R2 对象已不存在的引用。此操作不会删除任何有效快照，但会改写数据库。继续吗？"
      />
    </>
  );
}

function BadgePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-auto shrink-0 rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-ink-soft">
      {children}
    </span>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-semibold text-ink">{value}</span>
      <span className="text-ink-faint">{label}</span>
    </div>
  );
}

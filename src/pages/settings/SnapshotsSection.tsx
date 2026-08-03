import { Camera } from 'lucide-react';
import { Select, Skeleton } from '@/components/ui';
import { useUpdateUserSettings, useUserSettings } from '@/hooks/queries';
import { Card } from './Card';

/**
 * "快照保留数量" options: the cap per bookmark. -1 = unlimited.
 * Ordered from the free tier's sensible default up through a generous cap.
 */
const RETENTION_OPTIONS = [
  { value: '-1', label: '不限制' },
  { value: '2', label: '2 个' },
  { value: '3', label: '3 个' },
  { value: '5', label: '5 个' },
  { value: '8', label: '8 个' },
  { value: '10', label: '10 个' },
];

/**
 * Website snapshot preferences + a plain-language explanation of the feature.
 *
 * The retention limit caps how many snapshots a bookmark keeps; when the count
 * would exceed it, the OLDEST snapshot is pruned automatically (the latest
 * stays). -1 disables pruning entirely.
 */
export function SnapshotsSection() {
  const { data, isLoading } = useUserSettings();
  const update = useUpdateUserSettings();

  if (isLoading || !data) {
    return (
      <Card title="快照">
        <Skeleton className="h-40 w-full" />
      </Card>
    );
  }

  return (
    <>
      <Card
        title="保留策略"
        description="控制每个书签最多保留多少份快照。超过限制时，系统会自动删除最旧的快照以释放空间。"
      >
        <div className="flex flex-col gap-3.5">
          <Select
            label="保留快照数量"
            value={String(data.snapshotRetentionLimit)}
            onChange={(e) => update.mutate({ snapshotRetentionLimit: Number(e.target.value) })}
            options={RETENTION_OPTIONS}
            hint="设为「不限制」则保留全部历史快照。默认 5 个。缓存过期后快照仍在 R2 中，此设置不回收已生成的图片。"
          />
        </div>
      </Card>

      <Card title="快照功能说明">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-brand-soft p-2 text-brand-ink" aria-hidden>
            <Camera size={16} />
          </div>
          <div className="min-w-0 space-y-2 text-xs leading-relaxed text-ink-soft">
            <p>
              快照会保存网页当时的完整内容。即使原网页之后被删除、改版或无法访问，你仍可在
              TagNest 中查看保存时的页面效果。
            </p>
            <p>
              建议启用智能去重功能，避免同一页面的重复内容反复占用存储空间。该功能会在后续版本中提供。
            </p>
          </div>
        </div>
      </Card>
    </>
  );
}

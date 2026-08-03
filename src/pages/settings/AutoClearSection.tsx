import { Input, Skeleton, Switch } from '@/components/ui';
import { useUpdateUserSettings, useUserSettings } from '@/hooks/queries';
import { Card } from './Card';

/**
 * 「自动清空」设置 — two independent idle auto-clear modules.
 *
 * Each module has an enable switch and a delay (seconds). When enabled, the
 * app clears the corresponding filter after the configured delay of no user
 * interaction, helping the user return to the initial state quickly. Defaults:
 * search 15s, tags 30s.
 */
export function AutoClearSection() {
  const { data, isLoading } = useUserSettings();
  const update = useUpdateUserSettings();

  if (isLoading || !data) {
    return (
      <Card title="自动清空">
        <Skeleton className="h-48 w-full" />
      </Card>
    );
  }

  return (
    <Card title="自动清空" description="在持续无操作后将界面过滤状态恢复为初始，帮助你快速回到起点提升效率。">
      <div className="flex flex-col gap-5">
        <AutoClearModule
          title="搜索框自动清空"
          description="启用后在持续无操作一段时间后自动清空搜索框内容。"
          enabled={data.searchAutoClearEnabled}
          onToggle={(v) => update.mutate({ searchAutoClearEnabled: v })}
          delay={data.searchAutoClearDelay}
          onDelay={(v) => update.mutate({ searchAutoClearDelay: v })}
        />

        <div className="h-px bg-line" />

        <AutoClearModule
          title="标签选中自动清空"
          description="启用后在持续无操作一段时间后自动清除标签筛选，回到全部书签视图。"
          enabled={data.tagsAutoClearEnabled}
          onToggle={(v) => update.mutate({ tagsAutoClearEnabled: v })}
          delay={data.tagsAutoClearDelay}
          onDelay={(v) => update.mutate({ tagsAutoClearDelay: v })}
        />
      </div>
    </Card>
  );
}

function AutoClearModule({
  title,
  description,
  enabled,
  onToggle,
  delay,
  onDelay,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  delay: number;
  onDelay: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Switch checked={enabled} onChange={onToggle} label={title} hint={description} />

      <div className={enabled ? '' : 'pointer-events-none opacity-40'}>
        <Input
          type="number"
          min={1}
          max={86400}
          step={1}
          label="持续无操作延迟"
          value={delay}
          disabled={!enabled}
          onChange={(e) => {
            const n = Math.floor(Number(e.target.value));
            if (Number.isFinite(n) && n >= 1) onDelay(Math.min(n, 86400));
          }}
          slotRight={<UnitLabel />}
          containerClassName="max-w-xs"
        />
      </div>
    </div>
  );
}

function UnitLabel() {
  return <span className="text-xs text-ink-faint">秒</span>;
}

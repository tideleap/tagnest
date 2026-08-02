import { Badge } from '@/components/ui';
import { Card } from './Card';

export function AboutSection() {
  return (
    <Card title="关于 TagNest">
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-soft">
        <p>
          TagNest 是一个键盘优先的书签管理器，跑在 Cloudflare 上。数据属于你，随时可以完整导出。
        </p>
        <dl className="flex flex-col gap-2 border-t border-line pt-3 text-xs">
          <div className="flex justify-between">
            <dt>版本</dt>
            <dd className="tabular-nums text-ink">1.0.0</dd>
          </div>
          <div className="flex justify-between">
            <dt>许可证</dt>
            <dd>
              <Badge tone="positive">MIT</Badge>
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>运行环境</dt>
            <dd className="text-ink">Cloudflare Pages + D1</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

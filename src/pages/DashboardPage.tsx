import { Link } from 'react-router-dom';
import {
  Archive,
  ArrowRight,
  Bookmark as BookmarkIcon,
  CalendarPlus,
  Layers,
  Plus,
  Star,
  Tag as TagIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import { cx } from '@/lib/cx';
import { useStats } from '@/hooks/queries';
import { Button, Skeleton } from '@/components/ui';

/**
 * B8 — 概览页 (/dashboard).
 *
 * A glanceable landing dashboard built entirely on the existing /stats
 * endpoint, so it stays cheap and needs no new backend surface. Cards are
 * click-through to the relevant section where it adds value.
 */

function MetricCard({
  icon,
  label,
  value,
  sub,
  to,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value?: number;
  sub?: string;
  to?: string;
  tone?: 'positive' | 'caution';
}) {
  const body = (
    <div className="rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <div className="flex items-center justify-between gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-sunken text-ink-soft">
          {icon}
        </span>
        {to && <ArrowRight size={14} className="text-ink-faint" aria-hidden />}
      </div>
      <p
        className={cx(
          'mt-3 text-2xl font-semibold tabular-nums leading-none',
          tone === 'positive' && value != null && value > 0 ? 'text-positive-ink' : 'text-ink',
          tone === 'caution' && value != null && value > 0 ? 'text-caution-ink' : 'text-ink',
        )}
      >
        {value === undefined ? <Skeleton className="h-6 w-14" /> : value}
      </p>
      <p className="mt-1.5 text-xs text-ink-soft">{label}</p>
      {sub && <p className="mt-0.5 text-2xs text-ink-faint">{sub}</p>}
    </div>
  );

  if (!to) return body;
  return (
    <Link to={to} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
      {body}
    </Link>
  );
}

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {hint && <p className="text-2xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function DashboardPage() {
  const stats = useStats();
  const s = stats.data;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pb-10 pt-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">概览</h1>
          <p className="mt-1 text-sm text-ink-soft">你的书签库一次扫视。</p>
        </div>
        <Link to="/import" className="shrink-0">
          <Button variant="primary" size="sm">
            <Upload size={15} aria-hidden />
            导入
          </Button>
        </Link>
      </header>

      <section aria-label="核心指标">
        <SectionHeader title="书签库" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard
            icon={<BookmarkIcon size={16} aria-hidden />}
            label="全部书签"
            value={s?.bookmarks}
            to="/library/all"
          />
          <MetricCard
            icon={<CalendarPlus size={16} aria-hidden />}
            label="近 7 天新增"
            value={s?.addedLast7Days}
            tone="positive"
          />
          <MetricCard
            icon={<TagIcon size={16} aria-hidden />}
            label="标签"
            value={s?.tags}
            to="/tags"
          />
          <MetricCard
            icon={<Star size={16} aria-hidden />}
            label="收藏"
            value={s?.favorites}
            to="/library/favorites"
          />
        </div>
      </section>

      <section aria-label="库健康">
        <SectionHeader title="维护" hint="批量、归档与回收" />
        <div className="grid grid-cols-3 gap-3">
          <MetricCard
            icon={<Layers size={16} aria-hidden />}
            label="未打标"
            value={s?.untagged}
            tone="caution"
            to="/library/all"
            sub={s && s.untagged > 0 ? '建议补标签' : '整理完毕'}
          />
          <MetricCard
            icon={<Archive size={16} aria-hidden />}
            label="已归档"
            value={s?.archived}
            to="/library/archive"
          />
          <MetricCard
            icon={<Trash2 size={16} aria-hidden />}
            label="回收站"
            value={s?.trashed}
            tone="caution"
            to="/library/trash"
            sub={s && s.trashed > 0 ? '可清理' : '空的'}
          />
        </div>
      </section>

      <section aria-label="快捷操作">
        <SectionHeader title="快捷操作" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {[
            { to: '/library/all', icon: <Layers size={15} aria-hidden />, label: '查看全部书签' },
            { to: '/tags', icon: <TagIcon size={15} aria-hidden />, label: '管理标签' },
            { to: '/tab-groups', icon: <Archive size={15} aria-hidden />, label: '标签页组' },
          ].map((a) => (
            <Link
              key={a.to}
              to={a.to}
              className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors hover:border-line-strong hover:text-brand-ink"
            >
              <span className="text-ink-soft">{a.icon}</span>
              <span className="truncate">{a.label}</span>
            </Link>
          ))}
          <Link
            to="/library/all"
            className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong px-3 py-2.5 text-sm font-medium text-brand-ink transition-colors hover:bg-brand-soft"
          >
            <Plus size={15} aria-hidden />
            添加书签
          </Link>
        </div>
      </section>
    </div>
  );
}

import { useMemo } from 'react';
import { BarChart3, HeartPulse, Library, Sparkles, Tags, TrendingUp } from 'lucide-react';
import { Badge, Card, CardBody, CardHeader, PageHeader, Skeleton } from '@/components/ui';
import { Reveal, Stagger } from '@/components/atelier';
import { useStats, useStatsTrend } from '@/hooks/queries';
import { useHealthReport } from '@/hooks/queries/health';
import { useAiOverview } from '@/hooks/queries/organize';
import { useTags } from '@/hooks/queries';

/**
 * A3 — the statistics report page.
 *
 * A read-only, single-glance summary of the whole library. It is deliberately
 * a *composition* layer: every number comes from an endpoint that already
 * powers another surface (stats, health, AI overview, tags, trend), so the
 * figures here can never drift out of sync with the metrics the user sees
 * elsewhere. There is no new aggregation logic to disagree with.
 *
 * Five cards, one row of headline numbers, and a per-day trend chart. All
 * queries fire in parallel; the slowest is the health report, which is pure
 * SQL, so the page renders well under a second.
 */

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function ReportPage() {
  const { data: stats, isLoading: statsLoading } = useStats();
  const { data: health, isLoading: healthLoading } = useHealthReport();
  const { data: overview, isLoading: overviewLoading } = useAiOverview();
  const { data: tags, isLoading: tagsLoading } = useTags();
  const { data: trend, isLoading: trendLoading } = useStatsTrend(180);

  // Tag distribution: top 15 by usage, everything else folded into "其他".
  const distribution = useMemo(() => {
    if (!tags) return [];
    const sorted = [...tags].sort((a, b) => b.count - a.count);
    const top = sorted.slice(0, 15);
    const rest = sorted.slice(15);
    const restCount = rest.reduce((s, t) => s + t.count, 0);
    const items: Array<{ name: string; count: number; other?: boolean }> = top.map((t) => ({
      name: t.name,
      count: t.count,
    }));
    if (rest.length > 0) items.push({ name: '其他', count: restCount, other: true });
    return items;
  }, [tags]);

  const loading = statsLoading || healthLoading || overviewLoading || tagsLoading || trendLoading;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={<BarChart3 size={14} aria-hidden />}
        eyebrow="数据洞察"
        index="11 / 16"
        title="报告"
        description="书签库的整体画像——规模、标签分布、收藏趋势、AI 贡献与健康度，一页看全。"
      />

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          {/* Headline numbers */}
          <Stagger className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Headline label="书签总数" value={String(stats?.bookmarks ?? 0)} />
            <Headline label="标签数" value={String(stats?.tags ?? 0)} />
            <Headline label="收藏" value={String(stats?.favorites ?? 0)} />
            <Headline label="近 7 天新增" value={String(stats?.addedLast7Days ?? 0)} />
            <Headline label="待整理" value={String(stats?.untagged ?? 0)} />
            <Headline
              label="健康分"
              value={health ? String(health.score) : '—'}
              tone={health ? scoreTone(health.score) : undefined}
            />
          </Stagger>

          <Reveal delay={120} className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* Collection trend */}
            <Card>
              <CardHeader
                title={<span className="inline-flex items-center gap-1.5"><TrendingUp size={14} aria-hidden />收藏趋势</span>}
                hint="最近 180 天每日新增"
              />
              <CardBody>
                <TrendChart points={trend?.days ?? []} />
              </CardBody>
            </Card>

            {/* Tag distribution */}
            <Card>
              <CardHeader
                title={<span className="inline-flex items-center gap-1.5"><Tags size={14} aria-hidden />标签分布</span>}
                hint="按使用次数，前 15 名"
              />
              <CardBody>
                <Distribution items={distribution} />
              </CardBody>
            </Card>

            {/* AI contribution */}
            <Card>
              <CardHeader
                title={<span className="inline-flex items-center gap-1.5"><Sparkles size={14} aria-hidden />AI 贡献度</span>}
                hint="标签链接来源与采纳率"
              />
              <CardBody>
                <AiContribution
                  aiLinks={overview?.aiTagLinks ?? 0}
                  userLinks={overview?.userTagLinks ?? 0}
                  weightedRate={overview?.contribution?.weightedRate ?? 0}
                  acceptRate={overview?.feedback?.acceptanceRate ?? 0}
                />
              </CardBody>
            </Card>

            {/* Library health */}
            <Card>
              <CardHeader
                title={<span className="inline-flex items-center gap-1.5"><HeartPulse size={14} aria-hidden />库健康度</span>}
                hint="重复与孤儿标签"
              />
              <CardBody>
                <HealthSummary
                  score={health?.score ?? 0}
                  duplicateGroups={health?.duplicateGroups.length ?? 0}
                  duplicateExtra={health?.duplicateExtra ?? 0}
                  orphanTags={health?.orphanTags.length ?? 0}
                />
              </CardBody>
            </Card>
          </Reveal>

          {/* Library scale strip */}
          <Reveal delay={180}>
          <Card>
            <CardHeader title={<span className="inline-flex items-center gap-1.5"><Library size={14} aria-hidden />库规模</span>} hint="按状态拆分" />
            <CardBody>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <ScaleCell label="活跃" value={stats?.bookmarks ?? 0} />
                <ScaleCell label="收藏" value={stats?.favorites ?? 0} />
                <ScaleCell label="归档" value={stats?.archived ?? 0} />
                <ScaleCell label="回收站" value={stats?.trashed ?? 0} />
                <ScaleCell label="未标签" value={stats?.untagged ?? 0} />
              </div>
            </CardBody>
          </Card>
          </Reveal>
        </>
      )}
    </div>
  );
}

function scoreTone(score: number): 'positive' | 'caution' | 'critical' {
  if (score >= 80) return 'positive';
  if (score >= 50) return 'caution';
  return 'critical';
}

function Headline({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'caution' | 'critical';
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface px-3 py-2.5">
      <span className="text-2xs text-ink-faint">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="text-lg font-semibold tabular-nums text-ink">{value}</span>
        {tone && <Badge tone={tone}>{tone === 'positive' ? '良好' : tone === 'caution' ? '一般' : '需关注'}</Badge>}
      </span>
    </div>
  );
}

/** Per-day additions as a compact bar strip; quiet days render as gaps. */
function TrendChart({ points }: { points: Array<{ date: string; count: number }> }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const total = points.reduce((s, p) => s + p.count, 0);

  if (points.length === 0) {
    return <p className="text-2xs text-ink-faint">最近 180 天没有新增书签。</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-20 items-end gap-px" role="img" aria-label={`180 天共新增 ${total} 个书签`}>
        {points.map((p) => (
          <div
            key={p.date}
            className="min-w-[2px] flex-1 rounded-t-sm bg-brand-soft"
            style={{ height: `${Math.max(4, (p.count / max) * 100)}%` }}
            title={`${p.date}：${p.count} 个`}
          />
        ))}
      </div>
      <p className="text-2xs text-ink-faint">
        窗口内共新增 <span className="font-medium tabular-nums text-ink">{total}</span> 个书签，峰值单日{' '}
        <span className="font-medium tabular-nums text-ink">{max}</span> 个。
      </p>
    </div>
  );
}

/** Horizontal bars sized by usage count. */
function Distribution({ items }: { items: Array<{ name: string; count: number; other?: boolean }> }) {
  if (items.length === 0) {
    return <p className="text-2xs text-ink-faint">还没有标签。</p>;
  }
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li key={item.name} className="flex items-center gap-2">
          <span className="w-24 shrink-0 truncate text-2xs text-ink-soft" title={item.name}>
            {item.name}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
            <div
              className={`h-full rounded-full ${item.other ? 'bg-line' : 'bg-brand'}`}
              style={{ width: `${(item.count / max) * 100}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-2xs tabular-nums text-ink-faint">
            {item.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AiContribution({
  aiLinks,
  userLinks,
  weightedRate,
  acceptRate,
}: {
  aiLinks: number;
  userLinks: number;
  weightedRate: number;
  acceptRate: number;
}) {
  const total = aiLinks + userLinks || 1;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-ink-faint">AI 价值加权贡献</span>
        <span className="text-sm font-semibold tabular-nums text-ink">{pct(weightedRate)}</span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-sunken" role="img" aria-label={`AI ${aiLinks}，用户 ${userLinks}`}>
        <div className="h-full bg-brand" style={{ width: `${(aiLinks / total) * 100}%` }} />
        <div className="h-full bg-line" style={{ width: `${(userLinks / total) * 100}%` }} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="AI 标签链接" value={String(aiLinks)} />
        <MiniStat label="用户标签链接" value={String(userLinks)} />
        <MiniStat label="建议采纳率" value={pct(acceptRate)} />
      </div>
    </div>
  );
}

function HealthSummary({
  score,
  duplicateGroups,
  duplicateExtra,
  orphanTags,
}: {
  score: number;
  duplicateGroups: number;
  duplicateExtra: number;
  orphanTags: number;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-3xl font-semibold tabular-nums text-ink">{score}</span>
        <div className="flex flex-col">
          <span className="text-2xs text-ink-faint">健康分</span>
          <Badge tone={scoreTone(score)}>{score >= 80 ? '良好' : score >= 50 ? '一般' : '需关注'}</Badge>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="重复组" value={String(duplicateGroups)} />
        <MiniStat label="冗余书签" value={String(duplicateExtra)} />
        <MiniStat label="孤儿标签" value={String(orphanTags)} />
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-line bg-sunken/40 px-2 py-1.5">
      <span className="text-2xs text-ink-faint">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-ink">{value}</span>
    </div>
  );
}

function ScaleCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-line bg-surface px-2.5 py-2">
      <span className="text-2xs text-ink-faint">{label}</span>
      <span className="text-base font-semibold tabular-nums text-ink">{value}</span>
    </div>
  );
}

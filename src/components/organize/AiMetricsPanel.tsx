import type { AiOverview } from '@shared/types';

/**
 * AI organiser metrics, upgraded from the old single "AI 贡献度" ratio.
 *
 * Two cards:
 *   - Usage        — *how often* the user actually drives bookmarks through the
 *                    AI organiser (coverage + frequency over the last 30 days).
 *   - Contribution — *how much value* the AI delivers, as a value-weighted share
 *                    that distinguishes direct adoption, assisted editing, and the
 *                    domain-fallback engine, instead of a flat source ratio.
 *
 * Showing both keeps the feature honest: a high contribution with low usage means
 * the model is sharp but under-used; high usage with low contribution means the
 * user leans on it but constantly reworks what it proposes.
 */

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** A horizontal stacked bar whose segments are sized by `value` weights. */
function StackedBar({
  segments,
}: {
  segments: { key: string; value: number; className: string; label?: string }[];
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  return (
    <div
      className="flex h-2.5 w-full overflow-hidden rounded-full bg-sunken"
      role="img"
      aria-label={segments.map((s) => s.label ?? s.key).join(', ')}
    >
      {segments.map((s) => {
        const w = (Math.max(0, s.value) / total) * 100;
        if (w <= 0) return null;
        return (
          <div
            key={s.key}
            className={`h-full ${s.className}`}
            style={{ width: `${w}%` }}
          />
        );
      })}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-line bg-surface px-2.5 py-1.5">
      <span className="text-2xs text-ink-faint">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-ink" title={hint}>
        {value}
      </span>
    </div>
  );
}

function UsageCard({ usage }: { usage: AiOverview['usage'] }) {
  const scopeLabels: Record<'untagged' | 'all' | 'ids', string> = {
    untagged: '未打标签',
    all: '全库',
    ids: '单选',
  };
  const engineLabels: Record<'model' | 'fallback', string> = {
    model: '模型生成',
    fallback: '域名兜底',
  };
  const outcome = usage.suggestionOutcome;
  const outcomeTotal = outcome.accepted + outcome.rejected + outcome.pending || 1;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface/85 px-4 py-3.5 shadow-raised backdrop-blur-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-panel font-semibold tracking-tight text-ink">AI 整理使用率</span>
        <span className="text-xs tabular-nums text-ink-faint">
          过去 30 天 {usage.touchedBookmarks} / {usage.totalBookmarks} 条书签被 AI 整理
        </span>
        <span className="ml-auto text-sm font-semibold tabular-nums text-brand-ink">
          {pct(usage.adoptionRate)}
        </span>
      </div>

      <StackedBar
        segments={[
          { key: 'touched', value: usage.touchedBookmarks, className: 'bg-brand' },
          { key: 'rest', value: Math.max(0, usage.totalBookmarks - usage.touchedBookmarks), className: 'bg-sunken' },
        ]}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="整理场景分布" value={usage.byScope.map((s) => `${scopeLabels[s.target]} ${s.count}`).join(' · ')} />
        <Stat label="引擎分布" value={usage.byEngine.map((e) => `${engineLabels[e.engine]} ${e.count}`).join(' · ')} />
        <Stat label="整理频次" value={`${usage.runsLast30Days} 次 / 30天`} />
        <Stat label="平均每次" value={`${Math.round(usage.avgRunSize)} 条`} />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-2xs text-ink-faint">
          <span>建议处理结果</span>
          <span className="tabular-nums">
            已采纳 {outcome.accepted} · 已拒绝 {outcome.rejected} · 待确认 {outcome.pending} · 自动应用 {outcome.autoApplied}
          </span>
        </div>
        <StackedBar
          segments={[
            { key: 'accepted', value: outcome.accepted, className: 'bg-brand' },
            { key: 'rejected', value: outcome.rejected, className: 'bg-rose-400/70' },
            { key: 'pending', value: outcome.pending, className: 'bg-amber-300/70' },
          ]}
        />
        <div className="flex gap-3 text-2xs text-ink-faint">
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-brand align-middle" />已采纳</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-rose-400/70 align-middle" />已拒绝</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-300/70 align-middle" />待确认</span>
        </div>
        <div className="sr-only">{outcomeTotal}</div>
      </div>
    </section>
  );
}

function ContributionCard({ contribution }: { contribution: AiOverview['contribution'] }) {
  // Value weights, surfaced so the bar's AI portion literally equals weightedRate.
  const dV = contribution.directAi * 1.0;
  const aV = contribution.assistedAi * 0.6;
  const fV = contribution.fallbackAi * 0.5;
  const uV = contribution.userOnly * 1.0;
  const totalV = dV + aV + fV + uV || 1;
  const share = (v: number) => `${Math.round((v / totalV) * 100)}%`;

  const rows = [
    { label: 'AI 直接采纳', count: contribution.directAi, value: dV, weight: '权重 1.0' },
    { label: 'AI 辅助编辑', count: contribution.assistedAi, value: aV, weight: '权重 0.6' },
    { label: '域名兜底采纳', count: contribution.fallbackAi, value: fV, weight: '权重 0.5' },
    { label: '用户独立创建', count: contribution.userOnly, value: uV, weight: '基准 1.0' },
  ];

  const editAssist =
    contribution.raw.aiAccepted > 0
      ? Math.round((contribution.assistedAi / contribution.raw.aiAccepted) * 100)
      : 0;

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface/85 px-4 py-3.5 shadow-raised backdrop-blur-sm"
      title="价值加权模型：直接采纳计 1.0，用户改名后采纳计 0.6，域名兜底采纳计 0.5；被拒绝的建议不计入分母。"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-panel font-semibold tracking-tight text-ink">AI 贡献度</span>
        <span className="text-xs tabular-nums text-ink-faint">
          价值加权 · 已采纳 {contribution.raw.aiAccepted} · 拒绝 {contribution.raw.rejected}
        </span>
        <span className="ml-auto text-sm font-semibold tabular-nums text-brand-ink">
          {pct(contribution.weightedRate)}
        </span>
      </div>

      <StackedBar
        segments={[
          { key: 'direct', value: dV, className: 'bg-brand', label: 'AI 直接采纳' },
          { key: 'assisted', value: aV, className: 'bg-brand/60', label: 'AI 辅助编辑' },
          { key: 'fallback', value: fV, className: 'bg-brand/30', label: '域名兜底采纳' },
          { key: 'user', value: uV, className: 'bg-sunken', label: '用户独立创建' },
        ]}
      />

      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs text-ink-faint sm:grid-cols-4">
        {rows.map((r) => (
          <li key={r.label} className="flex flex-col">
            <span className="text-ink">{r.label}</span>
            <span className="tabular-nums">
              {r.count} 条 · 占价值 {share(r.value)} <span className="opacity-70">({r.weight})</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="提案命中率" value={pct(contribution.hitRate)} hint="已采纳 / (已采纳 + 已拒绝)" />
        <Stat label="采纳率" value={pct(contribution.acceptanceRate)} hint="已采纳 / 已决策建议" />
        <Stat label="编辑辅助占比" value={`${editAssist}%`} hint="改名后采纳 / 已采纳" />
      </div>
    </section>
  );
}

export function AiMetricsPanel({ overview }: { overview: AiOverview }) {
  if (!overview?.usage || !overview?.contribution) return null;
  return (
    <div className="flex flex-col gap-3">
      <UsageCard usage={overview.usage} />
      <ContributionCard contribution={overview.contribution} />
    </div>
  );
}

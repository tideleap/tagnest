import { BarChart3, Cpu } from 'lucide-react';
import type { AiJob, AiOverview } from '@shared/types';
import { Badge } from '@/components/ui';
import { cx } from '@/lib/cx';

/**
 * Observability for the AI organiser (Phase 5).
 *
 * The model's value is a claim until it can be measured. `feedback` carries the
 * per-decision tallies collected by the Phase 2 loop; here they become numbers
 * a human can watch move: how often a suggested tag is kept (采纳率), how often
 * a proposed tag is ultimately accepted across the whole queue (命中率), and a
 * 30-day accept/reject trend so a prompt change has a before/after to beat.
 *
 * The trend is plain CSS bars — no charting dependency, and it survives a
 * reload because the data comes straight from the overview endpoint.
 */

interface Props {
  overview: AiOverview | undefined;
}

const ENGINE_LABEL: Record<string, string> = {
  model: '模型',
  heuristic: '本地规则',
  mixed: '模型 + 本地规则',
  none: '未运行',
};

export function EvaluationPanel({ overview }: Props) {
  if (!overview) return null;

  const { feedback, feedbackTrend, promptVersion, recentJobs } = overview;
  const hasData = feedback.total > 0 || feedback.proposalTotal > 0;

  return (
    <section className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <BarChart3 size={17} className="shrink-0 text-brand" aria-hidden />
          <h2 className="text-sm font-semibold text-ink">整理效果评估</h2>
        </div>
        <Badge tone="brand" dot>
          Prompt {promptVersion}
        </Badge>
      </div>

      {!hasData && (
        <p className="rounded-md bg-sunken px-3 py-2 text-xs leading-relaxed text-ink-soft">
          还没有决策数据。运行一次整理并在「确认」页接受或忽略建议后，这里会显示采纳率与命中率趋势。
        </p>
      )}

      {hasData && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Metric
              label="采纳率"
              hint="用户做出的决定中，保留建议的比例（含改名）"
              value={Math.round(feedback.acceptanceRate * 100)}
              tone="brand"
            />
            <Metric
              label="命中率"
              hint="全部提案中，最终被接受的标签占比"
              value={Math.round(feedback.hitRate * 100)}
              tone="positive"
            />
          </div>

          <p className="text-2xs tabular-nums text-ink-faint">
            接受 <span className="text-ink-soft">{feedback.accepted}</span> ·
            忽略 <span className="text-ink-soft">{feedback.rejected}</span> ·
            改名 <span className="text-ink-soft">{feedback.modified}</span> ·
            共 <span className="text-ink-soft">{feedback.total}</span> 条反馈
            {' · '}
            提案命中 <span className="text-ink-soft">{feedback.proposalAccepted}</span>/
            {feedback.proposalTotal}
          </p>

          <TrendChart trend={feedbackTrend} />
        </>
      )}

      {recentJobs.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <p className="text-2xs font-medium text-ink-soft">最近整理（按 prompt 版本）</p>
          <ul className="flex flex-col gap-1">
            {recentJobs.slice(0, 5).map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  hint,
  value,
  tone,
}: {
  label: string;
  hint: string;
  value: number;
  tone: 'brand' | 'positive';
}) {
  const color = tone === 'brand' ? 'text-brand-ink' : 'text-positive-ink';
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-line bg-sunken/40 px-3 py-2">
      <span className="text-2xs text-ink-faint" title={hint}>
        {label}
      </span>
      <span className={cx('text-2xl font-semibold tabular-nums leading-none', color)}>
        {value}
        <span className="text-sm font-medium text-ink-faint">%</span>
      </span>
    </div>
  );
}

/**
 * 30-day accept/reject trend. Two stacked segments per day: accepted (brand) on
 * top, rejected (critical) underneath, each scaled to the busiest day so the
 * shape — not the absolute volume — reads at a glance. Days with no decisions
 * collapse to a flat baseline.
 */
function TrendChart({ trend }: { trend: AiOverview['feedbackTrend'] }) {
  if (trend.length === 0) return null;

  const peak = Math.max(1, ...trend.map((d) => d.accepted + d.rejected));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <p className="text-2xs font-medium text-ink-soft">近 30 天采纳情况</p>
        <div className="flex items-center gap-3 text-2xs text-ink-faint">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-brand" aria-hidden />
            接受
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-critical" aria-hidden />
            忽略
          </span>
        </div>
      </div>

      <div className="flex h-16 items-end gap-[2px] overflow-hidden" role="img" aria-label="近 30 天接受与忽略趋势">
        {trend.map((d) => {
          const total = d.accepted + d.rejected;
          const heightPct = Math.round((total / peak) * 100);
          return (
            <div
              key={d.date}
              className="group flex h-full flex-1 items-end"
              title={`${d.date} · 接受 ${d.accepted} · 忽略 ${d.rejected}`}
            >
              <div
                className="flex w-full flex-col justify-end overflow-hidden rounded-sm"
                style={{ height: `${heightPct}%` }}
              >
                {d.accepted > 0 && (
                  <div className="w-full bg-brand" style={{ height: `${(d.accepted / total) * 100}%` }} />
                )}
                {d.rejected > 0 && (
                  <div className="w-full bg-critical" style={{ height: `${(d.rejected / total) * 100}%` }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One recent run, surfacing its prompt version so revisions can be compared. */
function JobRow({ job }: { job: AiJob }) {
  const engine = job.engine ?? 'none';
  const date = job.createdAt.slice(0, 10);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-ink-faint">
      <span className="tabular-nums">{date}</span>
      <Badge tone={engine === 'model' || engine === 'mixed' ? 'brand' : 'neutral'}>
        <Cpu size={11} aria-hidden />
        {ENGINE_LABEL[engine] ?? engine}
      </Badge>
      {job.promptVersion ? (
        <Badge tone="neutral">Prompt {job.promptVersion}</Badge>
      ) : (
        <Badge tone="neutral">未知版本</Badge>
      )}
      <span className="ml-auto tabular-nums">
        {job.suggested} 条建议 · {job.processed}/{job.total}
      </span>
    </li>
  );
}

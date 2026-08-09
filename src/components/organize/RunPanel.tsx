import { AlertTriangle, CircleStop, Cpu, FolderTree, Play, Sparkles } from 'lucide-react';
import type { AiEngineKind, AiJobTarget, AiOverview, AutoGroupResult } from '@shared/types';
import { Badge, Button, SegmentedControl } from '@/components/ui';
import { cx } from '@/lib/cx';
import type { RunState } from '@/hooks/queries/organize';

/**
 * Scope selection, the run button, and live progress.
 *
 * Two decisions worth explaining:
 *
 * **`untagged` is the default scope.** Re-tagging bookmarks that already have
 * tags is mostly noise the user then has to reject; the bookmarks with nothing
 * on them are the ones the library genuinely cannot surface today.
 *
 * **The engine badge is always visible.** When the model is unreachable the
 * run silently continues on local rules — which is the right behaviour, but a
 * silent downgrade would look like a working model producing bad tags. The
 * badge names whichever engine actually produced the output.
 */

interface Props {
  overview: AiOverview | undefined;
  run: RunState & {
    start: (target: AiJobTarget, ids?: string[]) => Promise<unknown>;
    stop: () => void;
  };
  target: AiJobTarget;
  onTargetChange: (target: AiJobTarget) => void;
}

const ENGINE_LABEL: Record<AiEngineKind, string> = {
  model: '模型',
  heuristic: '本地规则',
  mixed: '模型 + 本地规则',
  none: '未运行',
};

export function RunPanel({ overview, run, target, onTargetChange }: Props) {
  const untagged = overview?.untaggedBookmarks ?? 0;
  const total = overview?.totalBookmarks ?? 0;
  const scopeSize = target === 'untagged' ? untagged : total;

  const job = run.job;
  const percent = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

  // Neither engine available means the button cannot do anything useful; say
  // why rather than letting the request fail.
  const noEngine = overview ? !overview.modelReady && !overview.heuristicsEnabled : false;

  return (
    <section className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles size={17} className="shrink-0 text-brand" aria-hidden />
          <h2 className="text-sm font-semibold text-ink">批量整理</h2>
          <EngineBadge overview={overview} engine={run.engine} />
        </div>

        {run.running ? (
          <Button size="sm" variant="secondary" iconLeft={<CircleStop size={15} />} onClick={run.stop}>
            停止
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            iconLeft={<Play size={15} />}
            disabled={noEngine || scopeSize === 0}
            onClick={() => void run.start(target)}
          >
            开始整理
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label="整理范围"
          size="sm"
          value={target}
          onChange={(value) => onTargetChange(value as AiJobTarget)}
          segments={[
            { value: 'untagged', label: `未打标签（${untagged}）` },
            { value: 'all', label: `全部书签（${total}）` },
          ]}
        />
        <p className="text-2xs text-ink-faint">
          {target === 'untagged'
            ? `AI 只分析还没有任何标签的书签，当前共 ${untagged} 条。`
            : `重新分析全部 ${total} 条书签，已有标签不会被覆盖，只会补充建议。`}
        </p>
      </div>

      {/* Progress. Rendered from server counters, so it reflects work done
          rather than an animation, and survives a reload mid-run. */}
      {job && (
        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
            <div
              className={cx(
                'h-full rounded-full transition-[width] duration-300',
                job.status === 'failed' ? 'bg-critical' : 'bg-brand',
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs tabular-nums text-ink-faint">
            <span>
              {job.processed} / {job.total} 已分析
            </span>
            <span>{job.suggested} 条建议</span>
            {run.autoApplied > 0 && <span>{run.autoApplied} 条已自动应用</span>}
            {job.failed > 0 && <span className="text-caution-ink">{job.failed} 条跳过</span>}
            <span className="ml-auto">{percent}%</span>
          </div>

          {/* Post-run topic distribution. The bar chart is pure CSS so it
              survives a reload and needs no charting dependency. */}
          {run.topics.length > 0 && (
            <div className="mt-1 flex flex-col gap-1">
              <p className="text-2xs font-medium text-ink-soft">本次整理主题分布</p>
              <ul className="flex flex-col gap-1">
                {run.topics.slice(0, 8).map((t) => {
                  const width = Math.max(6, Math.round((t.count / (run.topics[0]?.count || 1)) * 100));
                  return (
                    <li key={t.topic} className="flex items-center gap-2 text-2xs">
                      <span
                        className="w-24 shrink-0 truncate text-ink-faint"
                        title={t.topic}
                      >
                        {t.topic}
                      </span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
                        <span
                          className="block h-full rounded-full bg-brand"
                          style={{ width: `${width}%` }}
                        />
                      </span>
                      <span className="w-6 shrink-0 text-right tabular-nums text-ink-faint">
                        {t.count}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {noEngine && (
        <Notice tone="caution">
          未配置模型，且本地规则引擎已关闭。请到「设置 → AI」填写模型信息，或重新开启本地规则。
        </Notice>
      )}

      {/* A fallback is not an error, but it must not be invisible either. */}
      {run.modelError && !run.error && (
        <Notice tone="info">模型未参与：{run.modelError}（已使用本地规则继续）</Notice>
      )}

      {run.error && <Notice tone="critical">{run.error}</Notice>}

      {/* Post-run hierarchy summary. Shows when the server finished the automatic
          一级→二级→三级 grouping along with the tag organization. */}
      {run.autoGrouped && <HierarchySummary result={run.autoGrouped} />}
    </section>
  );
}

function HierarchySummary({ result }: { result: AutoGroupResult }) {
  if (result.createdCategories === 0 && result.relocated === 0) {
    return (
      <Notice tone="info">
        <span className="flex items-center gap-1.5">
          <FolderTree size={14} />
          本次整理未产生新的层级分组，现有标签层级已保持稳定。
        </span>
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-sunken px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink-soft">
        <FolderTree size={14} aria-hidden />
        已自动构建三级标签分组
      </p>
      <p className="text-2xs text-ink-faint">
        新建 {result.createdCategories} 个分类 · 调整 {result.relocated} 个标签 ·{' '}
        {result.untouched} 个保持原位
      </p>
      {result.summary.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {result.summary.slice(0, 8).map((line) => (
            <li
              key={line}
              className="inline-flex items-center rounded bg-surface px-1.5 py-0.5 text-2xs text-ink-soft"
            >
              {line}
            </li>
          ))}
          {result.summary.length > 8 && (
            <li className="text-2xs text-ink-faint">+{result.summary.length - 8}</li>
          )}
        </ul>
      )}
    </div>
  );
}

function EngineBadge({
  overview,
  engine,
}: {
  overview: AiOverview | undefined;
  engine: AiEngineKind | null;
}) {
  if (engine) {
    return (
      <Badge tone={engine === 'model' || engine === 'mixed' ? 'brand' : 'neutral'}>
        <Cpu size={11} aria-hidden />
        {ENGINE_LABEL[engine]}
      </Badge>
    );
  }
  if (!overview) return null;

  return overview.modelReady ? (
    <Badge tone="positive">模型已就绪</Badge>
  ) : (
    <Badge tone="neutral">本地规则模式</Badge>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: 'info' | 'caution' | 'critical';
  children: React.ReactNode;
}) {
  const styles = {
    info: 'bg-sunken text-ink-soft',
    caution: 'bg-caution-soft text-caution-ink',
    critical: 'bg-critical-soft text-critical-ink',
  }[tone];

  return (
    <p className={cx('flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-relaxed', styles)}>
      {tone !== 'info' && <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

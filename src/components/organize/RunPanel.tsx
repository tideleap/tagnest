import { AlertTriangle, CircleStop, Cpu, FlaskConical, FolderTree, Play, Sparkles } from 'lucide-react';
import type { AiEngineKind, AiJobTarget, AiOverview, AutoGroupResult } from '@shared/types';
import { Badge, Button, SegmentedControl } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useAiEstimate, type RunState } from '@/hooks/queries/organize';

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
 *
 * **The cost forecast is shown before the button works** (plan A1): pressing
 * "开始整理" authorises potentially hundreds of model calls, so the panel
 * states the scope size, call count and rough token consumption first. The
 * forecast is pure server-side arithmetic — no model is called to produce it.
 */

interface Props {
  overview: AiOverview | undefined;
  run: RunState & {
    start: (target: AiJobTarget, ids?: string[], limit?: number) => Promise<unknown>;
    stop: () => void;
  };
  target: AiJobTarget;
  onTargetChange: (target: AiJobTarget) => void;
  /**
   * CategorySync: which organiser track this panel drives. 'tagging' (default)
   * proposes loose labels; 'categorize' assigns each bookmark a single primary
   * category; 'rename' proposes a cleaner title per bookmark. The cost
   * forecast and the scope copy both follow the track.
   */
  kind?: 'tagging' | 'categorize' | 'rename';
}

/** How many bookmarks the trial run samples. One run chunk — small enough to
 *  judge quality, big enough to be representative. */
const TRIAL_SIZE = 20;

/** Renders a seconds count as a short human duration ("约 2 分钟" style). */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

const ENGINE_LABEL: Record<AiEngineKind, string> = {
  model: '模型',
  fallback: '域名兜底',
  none: '未运行',
};

export function RunPanel({ overview, run, target, onTargetChange, kind = 'tagging' }: Props) {
  const untagged = overview?.untaggedBookmarks ?? 0;
  const total = overview?.totalBookmarks ?? 0;
  const scopeSize = target === 'untagged' ? untagged : total;

  const isCategorize = kind === 'categorize';
  const isRename = kind === 'rename';

  // The forecast only makes sense while idle; a running job already has real
  // counters, and fetching mid-run would just churn the cache. Keyed by kind so
  // the two organiser tracks never share one stale number.
  const { data: estimateData } = useAiEstimate(target, !run.running && !run.job, kind);
  const estimate = estimateData?.estimate;

  const job = run.job;
  const percent = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

  // No model configured means the button cannot do anything useful; say why
  // rather than letting the request fail.
  const noEngine = overview ? !overview.modelReady : false;

  return (
    <section className="spotlight flex flex-col gap-3 rounded-xl border border-line bg-surface/85 p-5 shadow-raised backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles size={17} className="shrink-0 text-brand-accent" aria-hidden />
          <h2 className="font-display text-panel font-semibold tracking-tight text-ink">
            {isCategorize ? '精确分类' : isRename ? '命名清理' : '批量整理'}
          </h2>
          <EngineBadge overview={overview} engine={run.engine} />
        </div>

        {run.running ? (
          <Button size="sm" variant="secondary" iconLeft={<CircleStop size={15} />} onClick={run.stop}>
            停止
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            {/* Trial run (plan T2): sample a big scope before committing it.
                Only offered when there is more than one chunk to sample. */}
            {scopeSize > TRIAL_SIZE && (
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<FlaskConical size={15} />}
                disabled={noEngine}
                onClick={() => void run.start(target, undefined, TRIAL_SIZE)}
              >
                先试 {TRIAL_SIZE} 条
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              iconLeft={<Play size={15} />}
              disabled={noEngine || scopeSize === 0}
              onClick={() => void run.start(target)}
            >
              {isCategorize ? '开始分类' : isRename ? '开始清理' : '开始整理'}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label="整理范围"
          size="sm"
          value={target}
          onChange={(value) => onTargetChange(value as AiJobTarget)}
          segments={[
            {
              value: 'untagged',
              label: isCategorize
                ? `未分类（${untagged}）`
                : isRename
                  ? `全部书签（${total}）`
                  : `未打标签（${untagged}）`,
            },
            { value: 'all', label: `全部书签（${total}）` },
          ]}
        />
        <p className="text-2xs text-ink-faint">
          {isRename
            ? // Rename scans every live bookmark — private ones stay excluded
              // server-side; the untagged scope has no meaning for titles.
              `AI 检查全部 ${total} 条书签的标题，只建议清理无信息或冗余的命名，不会动品牌词。`
            : isCategorize
              ? target === 'untagged'
                ? `AI 只为还没有主分类的书签指定唯一归属，当前共 ${untagged} 条。`
                : `重新为全部 ${total} 条书签指定主分类，已有归属会被新建议覆盖（需确认）。`
              : target === 'untagged'
                ? `AI 只分析还没有任何标签的书签，当前共 ${untagged} 条。`
                : `重新分析全部 ${total} 条书签，已有标签不会被覆盖，只会补充建议。`}
        </p>
      </div>

      {/* Pre-run cost forecast (plan A1). Rendered only while idle — once a
          job exists, real counters below replace the estimate. */}
      {!job && estimate && estimate.bookmarks > 0 && (
        <div className="flex flex-col gap-1 rounded-md bg-sunken px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs tabular-nums text-ink-soft">
            <span>
              将分析 <strong className="font-semibold text-ink">{estimate.bookmarks}</strong> 条书签
            </span>
            {estimate.modelReady ? (
              <>
                <span>
                  约 <strong className="font-semibold text-ink">{estimate.estimatedCalls}</strong> 次模型调用
                  {estimate.maxModelCalls > estimate.estimatedCalls && (
                    <span className="text-ink-faint">（含重试上限 {estimate.maxModelCalls}）</span>
                  )}
                </span>
                <span>
                  输入约 {estimate.estimatedInputTokens.toLocaleString()} tokens · 输出约{' '}
                  {estimate.estimatedOutputTokens.toLocaleString()} tokens
                </span>
                <span>预计耗时约 {formatDuration(estimate.estimatedSeconds)}</span>
              </>
            ) : (
              <span>未配置模型，将仅使用域名兜底标签（不消耗 tokens）</span>
            )}
          </div>
          <p className="text-2xs text-ink-faint">
            token 数为估算值，实际以模型计费为准；建议先「先试 {TRIAL_SIZE} 条」确认质量再全量运行。
          </p>
          {estimate.capped && (
            <p className="text-2xs text-caution-ink">
              单次整理上限 2000 条，超出部分请在本次完成后再次运行。
            </p>
          )}
        </div>
      )}

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
          未配置模型。请到「设置 → AI」填写模型信息，整理将用模型生成更精准的标签。
        </Notice>
      )}

      {/* A fallback is not an error, but it must not be invisible either.
          Rename has no local fallback: with no model there is nothing to do. */}
      {run.modelError && !run.error && (
        <Notice tone="info">
          模型未参与：{run.modelError}
          {isRename ? '' : '（已使用域名兜底标签继续）'}
        </Notice>
      )}

      {/* Surface bookmarks that only got the fallback so they are never
          silently mislabeled as model-tagged. */}
      {run.uncovered > 0 && (
        <Notice tone="caution">
          本次有 {run.uncovered} 条书签仅生成了「域名兜底标签」，建议进入确认队列人工核对。
        </Notice>
      )}

      {/* CategorySync (C1-7): bookmarks a categorize run could not place at all
          — no model output AND no parseable host signal. They stay in 未分类,
          and the user should know how many and why. */}
      {isCategorize && run.uncategorized > 0 && (
        <Notice tone="caution">
          本次有 {run.uncategorized} 条书签无法判断归属，仍留在「未分类」，可稍后手动指定或再次运行。
        </Notice>
      )}

      {/* Adult quarantine: these bookmarks were never sent to the model (so one
          adult item cannot make the model refuse the whole batch). They got the
          neutral 「成人内容」 label and wait in the review queue. */}
      {run.adultQuarantined > 0 && (
        <Notice tone="caution">
          本次有 {run.adultQuarantined} 条书签疑似成人内容，已隔离归档为「成人内容」并跳过模型，请在确认队列中核对。
        </Notice>
      )}

      {run.applying && <Notice tone="info">正在应用整理结果…</Notice>}

      {run.error && <Notice tone="critical">{run.error}</Notice>}

      {/* P2-2: the run introduced a large share of new tags — the incremental
          pass has drifted, so suggest a full re-classify for a cleaner tree. */}
      {run.rebalanceWarning && (
        <Notice tone="caution">
          本次整理新增标签占比较高（≥30%），分类体系可能已偏离既有结构；建议择机对全库运行一次完整整理，让分类树重新收敛。
        </Notice>
      )}

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
      <Badge tone={engine === 'model' ? 'brand' : 'neutral'}>
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

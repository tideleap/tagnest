import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, Download, FolderTree, ListChecks, PenLine, Settings2, Sparkles, Tags, Wrench } from 'lucide-react';
import type { AiJobTarget } from '@shared/types';
import { Button, PageHeader, SegmentedControl } from '@/components/ui';
import { cx } from '@/lib/cx';import { RunPanel } from '@/components/organize/RunPanel';
import { CategoryExportPanel } from '@/components/organize/CategoryExportPanel';
import { AiMetricsPanel } from '@/components/organize/AiMetricsPanel';
import { EvaluationPanel } from '@/components/organize/EvaluationPanel';
import { SuggestionReview } from '@/components/organize/SuggestionReview';
import { TaxonomyPanel } from '@/components/organize/TaxonomyPanel';
import { AutoGroupPanel } from '@/components/organize/AutoGroupPanel';
import { HealthPanel } from '@/components/organize/HealthPanel';
import {
  useAiOverview,
  useAiSuggestions,
  useAiTaxonomyAudit,
  useOrganizeRun,
} from '@/hooks/queries/organize';
import { useTags } from '@/hooks/queries';

/**
 * The AI organiser page.
 *
 * ## 2026-08-30 redesign — the run is the hero
 *
 * The old page buried its primary action: two metric cards (~600px tall)
 * sat between the header and the "开始整理" button, and the user had to
 * parse two stacked segmented controls before reaching anything. The new
 * layout inverts the hierarchy:
 *
 *   1. **Hero run card** — track (tag/categorize/rename), scope, cost
 *      forecast, and the run buttons in one spotlight at the top. The
 *      description line follows the active track.
 *   2. **A four-cell stat strip** — the numbers a user actually acts on
 *      (pending confirmations, untagged backlog, acceptance rate, 30-day
 *      runs). "待确认" is a button: clicking it jumps straight to the
 *      review tab. The old metrics cards remain, one tab down.
 *   3. **One segmented control** — review / metrics / audit. Everything
 *      that is data-instead-of-action lives behind it.
 *
 * ## CategorySync: two organiser tracks, plus a rename track
 *
 * The page drives one of three tracks, selected inside the hero card:
 *
 *   标签整理 (tagging)    — the legacy loose-label flow: propose tags, write
 *                           to `bookmark_tags` on accept.
 *   精确分类 (categorize) — CategorySync C1: assign each bookmark exactly ONE
 *                           primary category, written to
 *                           `bookmark_primary_category` on accept.
 *   命名清理 (rename)     — conservative title clean-up: propose a better
 *                           title per bookmark, rewrite `bookmarks.title` on
 *                           accept. Never auto-applied; undo restores the
 *                           original title unless the user edited it after.
 *
 * All tracks share the job/run/review machinery; they differ in the `kind`
 * passed to the jobs + suggestions endpoints and in the review queue filter.
 * The `?mode=category` query param (linked from the Library's 未分类 group,
 * C2-5) lands directly on the categorize track.
 */

type Tab = 'run' | 'review' | 'insights' | 'audit';
type Mode = 'tagging' | 'categorize' | 'rename';

/**
 * Copy shown under the hero title for each track.
 */
const TRACK_DESCRIPTION: Record<Mode, string> = {
  tagging: '给待打标书签生成标签，确认后写入——标签库的词汇表在这里生长。',
  categorize: '为每条书签指定唯一主分类，确认后写入——分类树在这里成形。',
  rename: '清理无意义的书签标题，确认后改写——拿不准的标题不会被触碰。',
};

/** Copy shown inside the hero card for each track (action-oriented). */
const TRACK_TITLE: Record<Mode, string> = {
  tagging: '标签整理',
  categorize: '精确分类',
  rename: '命名清理',
};

export function OrganizePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('run');
  const [target, setTarget] = useState<AiJobTarget>('untagged');

  // Mode is URL-driven so the Library's "立即整理" entry point (C2-5) can
  // deep-link straight into the categorize track.
  const modeParam = searchParams.get('mode');
  const mode: Mode =
    modeParam === 'category' ? 'categorize' : modeParam === 'rename' ? 'rename' : 'tagging';
  const setMode = (next: Mode) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'categorize') params.set('mode', 'category');
        else if (next === 'rename') params.set('mode', 'rename');
        else params.delete('mode');
        return params;
      },
      { replace: true },
    );
  };

  const { data: overview } = useAiOverview();
  const run = useOrganizeRun();

  // Scoped to the current run right after one finishes, so "确认" shows what
  // was just produced rather than everything ever proposed.
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  // The review queue is kind-scoped: each track must only see its own
  // proposals, or an "apply all" would mix queues.
  const suggestionKind = mode === 'categorize' ? 'category' : mode === 'rename' ? 'rename' : 'tag';
  const {
    data: queue,
    isLoading: queueLoading,
    isError: queueFailed,
    refetch: refetchQueue,
  } = useAiSuggestions(reviewJobId, suggestionKind);

  // The audit is a full-vocabulary scan; only pay for it on its own tab.
  const { data: audit, isLoading: auditLoading } = useAiTaxonomyAudit(tab === 'audit');

  const pending = overview?.pendingSuggestions ?? 0;

  const startRun = async (nextTarget: AiJobTarget, ids?: string[], limit?: number) => {
    const job = await run.start(nextTarget, ids, limit, mode);
    if (job) {
      setReviewJobId(job.id);
      setTab('review');
    }
    return job;
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={<Sparkles size={14} aria-hidden />}
        eyebrow="AI 引擎"
        index="06 / 16"
        title="AI 整理"
        description={TRACK_DESCRIPTION[mode]}
      >
        {pending > 0 && (
          <span className="mr-1 text-xs tabular-nums text-ink-faint">{pending} 条待确认</span>
        )}
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<Settings2 size={15} />}
          onClick={() => navigate('/settings/ai')}
        >
          AI 设置
        </Button>
      </PageHeader>

      {/* Hero: the run is the page's primary object. Track switch, scope,
          cost forecast and the run buttons all live in this one spotlight. */}
      <HeroRunCard
        mode={mode}
        onModeChange={setMode}
        pending={pending}
        onReview={() => setTab('review')}
      >
        <RunPanel
          overview={overview}
          run={{ ...run, start: startRun }}
          target={target}
          onTargetChange={setTarget}
          kind={mode}
        />
        {/* The bookmarks.html export is the categorize track's "ship it" step,
            so it stays attached to the run card for that track only. */}
        {mode === 'categorize' && <CategoryExportPanel />}
      </HeroRunCard>

      {/* Four actionable numbers. The old ~600px metric cards move one tab
          down ("效果数据"); this strip is what survives above the fold. */}
      <StatStrip
        overview={overview}
        pending={pending}
        onReview={() => setTab('review')}
      />

      <SegmentedControl
        label="AI 整理视图"
        value={tab === 'run' ? 'review' : tab}
        onChange={setTab}
        segments={[
          {
            value: 'review',
            label: pending > 0 ? `确认（${pending}）` : '确认',
            icon: <ListChecks size={14} />,
          },
          { value: 'insights', label: '效果数据', icon: <BarChart3 size={14} /> },
          { value: 'audit', label: '体检与导出', icon: <Wrench size={14} /> },
        ]}
      />

      {tab === 'review' && (
        <div className="flex flex-col gap-3">
          {reviewJobId && (
            <div className="flex items-center gap-2 text-xs text-ink-faint">
              <span>正在查看最近一次整理的结果</span>
              <button
                type="button"
                onClick={() => setReviewJobId(null)}
                className="text-brand-ink underline-offset-2 hover:underline"
              >
                查看全部待确认
              </button>
            </div>
          )}
          <SuggestionReview
            suggestions={queue?.suggestions ?? []}
            loading={queueLoading}
            failed={queueFailed}
            onRetry={() => void refetchQueue()}
            kind={suggestionKind}
          />
        </div>
      )}

      {tab === 'insights' && (
        <div className="flex flex-col gap-3">
          {overview && <AiMetricsPanel overview={overview} />}
          <EvaluationPanel overview={overview} />
        </div>
      )}

      {tab === 'audit' && (
        <div className="flex flex-col gap-3">
          <HealthPanel />
          <AutoGroupPanel />
          <TaxonomyPanel audit={audit} loading={auditLoading} />
          <TagExportBar />
        </div>
      )}
    </div>
  );
}

/**
 * The hero card: track selection + engine badge at the top, then the
 * RunPanel (scope, forecast, run button, progress, notices) inside a
 * brand-tinted spotlight frame.
 *
 * Kept as a wrapper rather than folding RunPanel in wholesale: RunPanel
 * carries all the run-state plumbing (job progress, notices, hierarchy
 * summary) and is covered by its own tests. The hero adds only the
 * track-level chrome around it.
 */
function HeroRunCard({
  mode,
  onModeChange,
  pending,
  onReview,
  children,
}: {
  mode: Mode;
  onModeChange: (next: Mode) => void;
  pending: number;
  onReview: () => void;
  children: React.ReactNode;
}) {
  const tracks: { value: Mode; label: string; icon: React.ReactNode }[] = [
    { value: 'tagging', label: TRACK_TITLE.tagging, icon: <Tags size={14} /> },
    { value: 'categorize', label: TRACK_TITLE.categorize, icon: <FolderTree size={14} /> },
    { value: 'rename', label: TRACK_TITLE.rename, icon: <PenLine size={14} /> },
  ];

  return (
    <section
      className={cx(
        'flex flex-col gap-3 rounded-xl border p-5 shadow-raised backdrop-blur-sm',
        // Brand-tinted frame: the one deliberately louder surface on the page.
        'border-brand/30 bg-surface/85',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand/10 text-brand-ink">
            <Sparkles size={15} aria-hidden />
          </span>
          <h2 className="font-display text-panel font-semibold tracking-tight text-ink">
            {TRACK_TITLE[mode]}
          </h2>
        </div>
        <p className="min-w-0 flex-1 truncate text-xs text-ink-faint">
          {TRACK_DESCRIPTION[mode]}
        </p>
        {pending > 0 && (
          <button
            type="button"
            onClick={onReview}
            className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-1 text-2xs font-medium text-brand-ink transition-colors hover:bg-brand/20"
          >
            <ListChecks size={12} aria-hidden />
            {pending} 条待确认
          </button>
        )}
      </div>

      <SegmentedControl
        label="整理模式"
        value={mode}
        onChange={(value) => onModeChange(value as Mode)}
        segments={tracks}
      />

      {children}
    </section>
  );
}

/**
 * Four actionable numbers in one row. Deliberately stat-chip sized (the
 * heavy metric cards live in the insights tab): pending confirmations is
 * the primary call-to-action and renders as a clickable card.
 */
function StatStrip({
  overview,
  pending,
  onReview,
}: {
  overview: ReturnType<typeof useAiOverview>['data'];
  pending: number;
  onReview: () => void;
}) {
  const untagged = overview?.untaggedBookmarks ?? 0;
  const acceptance = overview?.feedback?.acceptanceRate;
  const runs30 = overview?.usage?.runsLast30Days;

  const cells: {
    label: string;
    value: string;
    hint: string;
    action?: () => void;
    accent?: boolean;
  }[] = [
    {
      label: '待确认',
      value: pending > 0 ? String(pending) : '—',
      hint: '点击进入确认队列',
      action: pending > 0 ? onReview : undefined,
      accent: pending > 0,
    },
    {
      label: '未打标签',
      value: String(untagged),
      hint: '默认整理范围',
    },
    {
      label: '采纳率',
      value: typeof acceptance === 'number' ? `${Math.round(acceptance * 100)}%` : '—',
      hint: '用户决定中保留建议的比例',
    },
    {
      label: '30 天整理',
      value: typeof runs30 === 'number' ? `${runs30} 次` : '—',
      hint: '最近一个月的整理运行次数',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="list" aria-label="AI 整理关键指标">
      {cells.map((c) => {
        const inner = (
          <>
            <span className="text-2xs text-ink-faint">{c.label}</span>
            <span
              className={cx(
                'text-lg font-semibold tabular-nums leading-tight',
                c.accent ? 'text-brand-ink' : 'text-ink',
              )}
            >
              {c.value}
            </span>
          </>
        );
        const base = cx(
          'flex flex-col gap-0.5 rounded-lg border px-3 py-2 transition-colors',
          c.accent
            ? 'border-brand/25 bg-brand/5'
            : 'border-line bg-surface',
        );
        return c.action ? (
          <button
            key={c.label}
            type="button"
            role="listitem"
            onClick={c.action}
            title={c.hint}
            className={cx(base, 'text-left hover:bg-brand/10')}
          >
            {inner}
          </button>
        ) : (
          <div key={c.label} role="listitem" title={c.hint} className={base}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Tag vocabulary export.
 *
 * Built client-side from the tag list already in cache: the taxonomy is small,
 * and a dedicated endpoint would be a second source of truth for data the app
 * has loaded anyway.
 */
function TagExportBar() {
  const { data: tags } = useTags();

  const download = (format: 'json' | 'csv') => {
    const list = tags ?? [];

    const content =
      format === 'json'
        ? JSON.stringify(
            list.map((t) => ({ name: t.name, count: t.count, colorIndex: t.colorIndex })),
            null,
            2,
          )
        : ['name,count', ...list.map((t) => `${JSON.stringify(t.name)},${t.count}`)].join('\n');

    const blob = new Blob([content], {
      type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tagnest-tags.${format}`;
    a.click();
    // Defer revocation: revoking synchronously can abort the download on Safari.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-xs text-ink-faint">导出标签体系</p>
      <Button size="sm" variant="ghost" iconLeft={<Download size={14} />} onClick={() => download('json')}>
        JSON
      </Button>
      <Button size="sm" variant="ghost" iconLeft={<Download size={14} />} onClick={() => download('csv')}>
        CSV
      </Button>
    </div>
  );
}

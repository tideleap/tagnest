import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, ListChecks, Settings2, Sparkles, Wrench } from 'lucide-react';
import type { AiJobTarget } from '@shared/types';
import { Button, PageHeader, SegmentedControl } from '@/components/ui';
import { RunPanel } from '@/components/organize/RunPanel';
import { SuggestionReview } from '@/components/organize/SuggestionReview';
import { TaxonomyPanel } from '@/components/organize/TaxonomyPanel';
import { AutoGroupPanel } from '@/components/organize/AutoGroupPanel';
import {
  useAiOverview,
  useAiSuggestions,
  useAiTaxonomyAudit,
  useOrganizeRun,
} from '@/hooks/queries/organize';
import { useTags } from '@/hooks/queries';

/**
 * The AI organiser workbench.
 *
 * ## Why this page exists
 *
 * AI tagging used to be an invisible side-effect of saving a bookmark: no
 * entry point, no progress, no history, no way to see or undo what it did. It
 * was, structurally, a feature nobody could use on purpose. Giving it a page
 * makes it something the user *goes to and operates* — which is what "core
 * capability" has to mean before the label is honest.
 *
 * Three tabs, matching the three things a person actually wants:
 *
 *   整理   pick a scope, run it, watch it work
 *   确认   review what came back and decide
 *   体检   clean up the tag vocabulary itself
 */

type Tab = 'run' | 'review' | 'audit';

export function OrganizePage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('run');
  const [target, setTarget] = useState<AiJobTarget>('untagged');

  const { data: overview } = useAiOverview();
  const run = useOrganizeRun();

  // Scoped to the current run right after one finishes, so "确认" shows what
  // was just produced rather than everything ever proposed.
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const {
    data: queue,
    isLoading: queueLoading,
    isError: queueFailed,
    refetch: refetchQueue,
  } = useAiSuggestions(reviewJobId);

  // The audit is a full-vocabulary scan; only pay for it on its own tab.
  const { data: audit, isLoading: auditLoading } = useAiTaxonomyAudit(tab === 'audit');

  const pending = overview?.pendingSuggestions ?? 0;

  const startRun = async (nextTarget: AiJobTarget) => {
    const job = await run.start(nextTarget);
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
        title="AI 整理"
        description="给待打标书签生成标签，确认后写入——标签库的词汇表在这里生长。"
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

      <ContributionBar overview={overview} />

      <SegmentedControl
        label="AI 整理视图"
        value={tab}
        onChange={setTab}
        segments={[
          { value: 'run', label: '整理', icon: <Sparkles size={14} /> },
          {
            value: 'review',
            label: pending > 0 ? `确认（${pending}）` : '确认',
            icon: <ListChecks size={14} />,
          },
          { value: 'audit', label: '体检', icon: <Wrench size={14} /> },
        ]}
      />

      {tab === 'run' && (
        <RunPanel
          overview={overview}
          run={{ ...run, start: startRun }}
          target={target}
          onTargetChange={setTarget}
        />
      )}

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
          />
        </div>
      )}

      {tab === 'audit' && (
        <div className="flex flex-col gap-3">
          <AutoGroupPanel />
          <TaxonomyPanel audit={audit} loading={auditLoading} />
          <TagExportBar />
        </div>
      )}
    </div>
  );
}

/**
 * How much of the tagging the AI is actually doing.
 *
 * Before the `source` column existed this question had no answer — a
 * model-written tag and a hand-typed one were the same row. Showing the split
 * keeps the feature honest: if the bar stays empty, the model is not earning
 * its place in the pipeline, whatever the settings page claims.
 */
function ContributionBar({
  overview,
}: {
  overview: ReturnType<typeof useAiOverview>['data'];
}) {
  if (!overview) return null;

  const total = overview.aiTagLinks + overview.userTagLinks;
  if (total === 0) return null;

  const aiPercent = Math.round((overview.aiTagLinks / total) * 100);

  return (
    <section className="flex flex-col gap-1.5 rounded-md border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-ink">AI 贡献度</span>
        <span className="text-xs tabular-nums text-ink-faint">
          {overview.aiTagLinks} / {total} 个标签关联由 AI 生成
        </span>
        <span className="ml-auto text-sm font-semibold tabular-nums text-brand-ink">
          {aiPercent}%
        </span>
      </div>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-sunken">
        <div className="h-full bg-brand transition-[width]" style={{ width: `${aiPercent}%` }} />
      </div>
      <p className="text-2xs text-ink-faint">
        全部 {overview.totalBookmarks} 条书签 · {overview.untaggedBookmarks} 条未打标签
        {overview.untaggedBookmarks === 0 && '（当前没有待整理的书签）'}
      </p>
    </section>
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
    URL.revokeObjectURL(url);
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

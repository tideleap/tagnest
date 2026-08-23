import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, FolderTree, ListChecks, Settings2, Sparkles, Tags, Wrench } from 'lucide-react';
import type { AiJobTarget } from '@shared/types';
import { Button, PageHeader, SegmentedControl } from '@/components/ui';
import { Reveal } from '@/components/atelier';
import { RunPanel } from '@/components/organize/RunPanel';
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
 *
 * ## CategorySync: two organiser tracks
 *
 * The page drives one of two tracks, selected by the top-level mode switch:
 *
 *   标签整理 (tagging)    — the legacy loose-label flow: propose tags, write
 *                           to `bookmark_tags` on accept.
 *   精确分类 (categorize) — CategorySync C1: assign each bookmark exactly ONE
 *                           primary category, written to
 *                           `bookmark_primary_category` on accept.
 *
 * Both tracks share the job/run/review machinery; they differ in the `kind`
 * passed to the jobs + suggestions endpoints and in the review queue filter.
 * The `?mode=category` query param (linked from the Library's 未分类 group,
 * C2-5) lands directly on the categorize track.
 */

type Tab = 'run' | 'review' | 'audit';
type Mode = 'tagging' | 'categorize';

export function OrganizePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('run');
  const [target, setTarget] = useState<AiJobTarget>('untagged');

  // Mode is URL-driven so the Library's "立即整理" entry point (C2-5) can
  // deep-link straight into the categorize track.
  const mode: Mode = searchParams.get('mode') === 'category' ? 'categorize' : 'tagging';
  const setMode = (next: Mode) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'categorize') params.set('mode', 'category');
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
  // The review queue is kind-scoped: the categorize track must only see
  // category proposals, and vice versa, or an "apply all" would mix queues.
  const suggestionKind = mode === 'categorize' ? 'category' : 'tag';
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
        description={
          mode === 'categorize'
            ? '为每条书签指定唯一主分类，确认后写入——分类树在这里成形。'
            : '给待打标书签生成标签，确认后写入——标签库的词汇表在这里生长。'
        }
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

      {overview && <AiMetricsPanel overview={overview} />}

      {/* CategorySync: the two organiser tracks. Everything below — run panel,
          review queue — follows whichever track is active. */}
      <SegmentedControl
        label="整理模式"
        value={mode}
        onChange={(value) => setMode(value as Mode)}
        segments={[
          { value: 'tagging', label: '标签整理', icon: <Tags size={14} /> },
          { value: 'categorize', label: '精确分类', icon: <FolderTree size={14} /> },
        ]}
      />

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
        <Reveal key="run" className="flex flex-col gap-4">
          <RunPanel
            overview={overview}
            run={{ ...run, start: startRun }}
            target={target}
            onTargetChange={setTarget}
            kind={mode}
          />
          <EvaluationPanel overview={overview} />
        </Reveal>
      )}

      {tab === 'review' && (
        <Reveal key="review" className="flex flex-col gap-3">
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
        </Reveal>
      )}

      {tab === 'audit' && (
        <Reveal key="audit" className="flex flex-col gap-3">
          <HealthPanel />
          <AutoGroupPanel />
          <TaxonomyPanel audit={audit} loading={auditLoading} />
          <TagExportBar />
        </Reveal>
      )}
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

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, RotateCcw, Sparkles, XCircle } from 'lucide-react';
import type { AiJob, AiJobStatus, AiJobTarget } from '@shared/types';
import { Button, ConfirmDialog, Skeleton } from '@/components/ui';
import { relativeTime } from '@/lib/url';
import { Card } from './Card';
import { useAiJobs, useAiJob, useCancelJob, useUndoJob } from '@/hooks/queries';

/**
 * AI batch-run history.
 *
 * Running a run already happens on the Organize page; this screen is the
 * "where did my runs go" view that the three `/api/ai/jobs` endpoints were
 * missing a caller for. It lists recent runs with live progress, lets a run
 * that is still going be cancelled, and links finished runs to the review
 * queue. The detail row pulls the freshest counters from `GET /ai/jobs/:id`
 * so a long run shows where it actually stopped.
 */

const STATUS_META: Record<AiJobStatus, { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'bg-sunken text-ink-soft' },
  running: { label: '进行中', cls: 'bg-brand-soft text-brand-ink' },
  done: { label: '已完成', cls: 'bg-positive-soft text-positive-ink' },
  failed: { label: '失败', cls: 'bg-caution-soft text-caution-ink' },
  cancelled: { label: '已取消', cls: 'bg-sunken text-ink-faint' },
};

const TARGET_LABEL: Record<AiJobTarget, string> = {
  untagged: '待打标书签',
  all: '全部书签',
  ids: '已选书签',
};

const ENGINE_LABEL: Record<string, string> = {
  model: '模型',
  fallback: '域名兜底',
  none: '无',
};

function progress(job: AiJob): number {
  if (job.total <= 0) return job.status === 'done' ? 100 : 0;
  return Math.min(100, Math.round((job.processed / job.total) * 100));
}

function isActive(status: AiJobStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function JobsSection() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useAiJobs();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isLoading) {
    return (
      <Card title="AI 整理任务">
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  if (isError) {
    return (
      <Card title="AI 整理任务">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-soft">
            任务列表加载失败。
          </p>
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>
            重试
          </Button>
        </div>
      </Card>
    );
  }

  const jobs = data?.jobs ?? [];

  if (jobs.length === 0) {
    return (
      <Card title="AI 整理任务">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-soft">
            还没有整理任务。在「AI 整理」页面选择范围后开始，这里会记录每一次运行。
          </p>
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<Sparkles size={15} />}
            onClick={() => navigate('/organize')}
          >
            去 AI 整理
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title="AI 整理任务" description="每一次批量整理的运行记录、进度与结果都保存在这里。">
      <ul className="flex flex-col gap-2">
        {jobs.map((job) => {
          const meta = STATUS_META[job.status];
          const open = expanded === job.id;
          return (
            <li key={job.id} className="rounded-md border border-line bg-surface-hover">
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : job.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  aria-expanded={open}
                >
                  <ChevronDown
                    size={15}
                    className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`}
                    aria-hidden
                  />
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${meta.cls}`}>
                    {meta.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink">
                    {TARGET_LABEL[job.target ?? 'untagged'] ?? '整理'}
                    <span className="ml-2 text-ink-faint">
                      {job.processed}/{job.total}
                    </span>
                  </span>
                  <span className="shrink-0 text-2xs tabular-nums text-ink-faint">
                    {relativeTime(job.createdAt)}
                  </span>
                </button>

                {isActive(job.status) && (
                  <CancelButton id={job.id} />
                )}
              </div>

              <div className="px-3 pb-2.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
                  <div
                    className="h-full bg-brand transition-[width]"
                    style={{ width: `${progress(job)}%` }}
                  />
                </div>
              </div>

              {open && <JobDetail id={job.id} onReview={() => navigate('/organize')} />}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Fetches the freshest counters from `GET /ai/jobs/:id` for the expanded row. */
function JobDetail({ id, onReview }: { id: string; onReview: () => void }) {
  const { data, isLoading } = useAiJob(id);
  const job = data?.job;
  const undo = useUndoJob();
  const [confirmUndo, setConfirmUndo] = useState(false);

  if (isLoading || !job) {
    return <Skeleton className="mx-3 mb-3 h-12 w-full" />;
  }

  // Undo is offered for settled runs that actually wrote something. A run
  // with zero accepted suggestions has nothing to roll back, so the button
  // would be a no-op — hide it rather than invite a confusing click.
  const canUndo =
    (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') &&
    job.suggested > 0;

  return (
    <div className="mx-3 mb-3 flex flex-col gap-2 rounded-md bg-sunken px-3 py-2.5 text-xs text-ink-soft">
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <span>
          建议标签：<span className="tabular-nums text-ink">{job.suggested}</span>
        </span>
        <span>
          处理失败：<span className="tabular-nums text-ink">{job.failed}</span>
        </span>
        <span>
          引擎：{ENGINE_LABEL[job.engine ?? 'none'] ?? job.engine ?? '—'}
        </span>
      </div>
      {job.error && <p className="text-caution-ink">错误：{job.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {job.status === 'done' && (
          <Button size="sm" variant="ghost" className="self-start" onClick={onReview}>
            查看建议
          </Button>
        )}
        {canUndo && (
          <Button
            size="sm"
            variant="ghost"
            className="self-start text-caution-ink"
            iconLeft={<RotateCcw size={14} />}
            loading={undo.isPending}
            onClick={() => setConfirmUndo(true)}
          >
            撤销本次整理
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmUndo}
        onClose={() => setConfirmUndo(false)}
        onConfirm={() => {
          undo.mutate(id);
          setConfirmUndo(false);
        }}
        title="撤销本次整理"
        message="将移除本次整理已接受的 AI 标签，并把对应建议放回待确认队列。你手动添加的标签不受影响。确定继续吗？"
        confirmLabel="撤销"
        tone="danger"
        loading={undo.isPending}
      />
    </div>
  );
}

function CancelButton({ id }: { id: string }) {
  const cancel = useCancelJob();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="shrink-0 text-caution-ink"
      iconLeft={<XCircle size={15} />}
      loading={cancel.isPending}
      onClick={() => cancel.mutate(id)}
    >
      取消
    </Button>
  );
}

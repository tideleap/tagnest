import { useMemo, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, Sparkles, X } from 'lucide-react';
import type { AiSuggestion } from '@shared/types';
import { Badge, Button, EmptyState, Skeleton } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useDecideSuggestions } from '@/hooks/queries/organize';
import { displayHost } from '@/lib/url';

/**
 * The review queue — where AI output becomes library data, or does not.
 *
 * ## Why this screen is the point of the refactor
 *
 * The model used to write tags straight into the library. That made every
 * proposal irreversible and unattributed, so the only responsible setting was
 * "off" — and off is exactly where the feature sat. Routing everything through
 * an explicit confirmation is what allows the model to be given far more
 * work: it can now run on every save, every import, and across the whole
 * library on demand, because none of it lands without a human yes.
 *
 * ## Grouping by bookmark, not by tag
 *
 * A flat list of 400 (bookmark, tag) rows is unreviewable — you cannot judge
 * "React" without seeing what it was proposed for, and you would see the same
 * bookmark six times. Grouping puts one decision in front of the user at a
 * time with the evidence attached.
 */

interface Props {
  suggestions: AiSuggestion[];
  loading?: boolean;
  /** The queue could not be fetched — distinct from "the queue is empty". */
  failed?: boolean;
  onRetry?: () => void;
  /** Restricts bulk actions to one run. */
  jobId?: string | null;
}

interface Group {
  bookmarkId: string;
  title: string;
  url: string;
  items: AiSuggestion[];
  /** Highest confidence in the group, used for ordering. */
  top: number;
  /** Topic phrase for the bookmark (shared by all rows of the group). */
  topic: string | null;
  /** Model flagged this proposal as needing a human sanity check. */
  needsReview: boolean;
}

/** Below this a proposal is shown but flagged as a guess. */
const LOW_CONFIDENCE = 0.55;

const SOURCE_LABEL: Record<string, string> = {
  model: '模型',
  heuristic: '规则',
  taxonomy: '标签体系',
};

function groupByBookmark(suggestions: AiSuggestion[]): Group[] {
  const map = new Map<string, Group>();

  for (const item of suggestions) {
    const held = map.get(item.bookmarkId);
    if (held) {
      held.items.push(item);
      held.top = Math.max(held.top, item.confidence);
      continue;
    }
    map.set(item.bookmarkId, {
      bookmarkId: item.bookmarkId,
      title: item.bookmarkTitle,
      url: item.bookmarkUrl,
      items: [item],
      top: item.confidence,
      topic: item.topic ?? null,
      needsReview: item.needsReview,
    });
  }

  // Strongest first: the user builds trust on the obvious ones before hitting
  // the borderline cases, which is also the order in which "accept all" is
  // least likely to be regretted.
  return [...map.values()].sort((a, b) => b.top - a.top);
}

export function SuggestionReview({ suggestions, loading, failed, onRetry, jobId }: Props) {
  const decide = useDecideSuggestions();
  // Locally hidden groups: the server round trip is fast but not instant, and
  // a card that lingers after a click reads as a broken button.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const groups = useMemo(
    () => groupByBookmark(suggestions).filter((g) => !dismissed.has(g.bookmarkId)),
    [suggestions, dismissed],
  );

  const hide = (bookmarkId: string) =>
    setDismissed((prev) => new Set(prev).add(bookmarkId));

  if (loading) {
    return (
      <ul className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i}>
            <Skeleton className="h-24 w-full rounded-md" />
          </li>
        ))}
      </ul>
    );
  }

  // A failed fetch must not masquerade as an empty queue: telling the user
  // "没有待确认的建议" hides the fault and they will never think to retry.
  if (failed) {
    return (
      <EmptyState
        icon={<AlertTriangle size={22} />}
        title="建议列表加载失败"
        description="没能读取到 AI 生成的标签建议，已生成的建议不会丢失。稍后重试即可。"
        action={
          onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              重试
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles size={22} />}
        title="没有待确认的建议"
        description="运行一次整理，AI 会在这里列出它为每条书签推荐的标签，确认后才会写入。"
      />
    );
  }

  const totalTags = groups.reduce((sum, g) => sum + g.items.length, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-ink-faint">
          {groups.length} 条书签 · {totalTags} 个待确认标签
        </p>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={decide.isPending}
            onClick={() => {
              setDismissed(new Set(groups.map((g) => g.bookmarkId)));
              decide.mutate({ action: 'reject', ...(jobId ? { jobId } : {}) });
            }}
          >
            全部忽略
          </Button>
          <Button
            size="sm"
            variant="primary"
            iconLeft={<Check size={15} />}
            loading={decide.isPending}
            onClick={() => {
              setDismissed(new Set(groups.map((g) => g.bookmarkId)));
              decide.mutate({ action: 'accept', ...(jobId ? { jobId } : {}) });
            }}
          >
            全部应用
          </Button>
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {groups.map((group) => (
          <li
            key={group.bookmarkId}
            className="rounded-md border border-line bg-surface p-3 transition-colors hover:border-line-strong"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {group.title || group.url}
                </p>
                <a
                  href={group.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-0.5 inline-flex items-center gap-1 text-2xs text-ink-faint hover:text-ink-soft"
                >
                  {displayHost(group.url)}
                  <ExternalLink size={11} aria-hidden />
                </a>
                {(group.topic || group.needsReview) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {group.topic && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-2xs text-ink-soft">
                        <Sparkles size={11} aria-hidden />
                        {group.topic}
                      </span>
                    )}
                    {group.needsReview && (
                      <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-caution/60 px-1.5 py-0.5 text-2xs text-caution">
                        <AlertTriangle size={11} aria-hidden />
                        需复核
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex shrink-0 gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  iconLeft={<X size={14} />}
                  onClick={() => {
                    hide(group.bookmarkId);
                    decide.mutate({ action: 'reject', ids: group.items.map((i) => i.id) });
                  }}
                >
                  忽略
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  iconLeft={<Check size={14} />}
                  onClick={() => {
                    hide(group.bookmarkId);
                    decide.mutate({ action: 'accept', ids: group.items.map((i) => i.id) });
                  }}
                >
                  全部接受
                </Button>
              </div>
            </div>

            {/* Per-tag decisions. The common case is "most of these are right,
                one is not", which a group-level yes/no cannot express. */}
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {group.items.map((item) => (
                <li key={item.id}>
                  <TagProposal
                    item={item}
                    onAccept={() => decide.mutate({ action: 'accept', ids: [item.id] })}
                    onReject={() => decide.mutate({ action: 'reject', ids: [item.id] })}
                  />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TagProposal({
  item,
  onAccept,
  onReject,
}: {
  item: AiSuggestion;
  onAccept: () => void;
  onReject: () => void;
}) {
  const [decided, setDecided] = useState<'accept' | 'reject' | null>(null);
  const low = item.confidence < LOW_CONFIDENCE;
  const percent = Math.round(item.confidence * 100);

  if (decided) {
    return (
      <span
        className={cx(
          'inline-flex h-7 items-center gap-1 rounded-md px-2 text-2xs',
          decided === 'accept' ? 'bg-positive-soft text-positive-ink' : 'bg-sunken text-ink-faint',
        )}
      >
        {decided === 'accept' ? <Check size={12} /> : <X size={12} />}
        {item.tagName}
      </span>
    );
  }

  return (
    <span
      // The reason is the whole argument for trusting the tag; a tooltip is
      // the only place it fits without turning the queue into an essay.
      title={item.reason ?? undefined}
      className={cx(
        'inline-flex h-7 items-center gap-1 rounded-md border pl-2 pr-1 text-2xs',
        low ? 'border-dashed border-caution/60 text-ink-soft' : 'border-line text-ink',
      )}
    >
      <span className="font-medium">{item.tagName}</span>
      <span className="tabular-nums text-ink-faint">{percent}%</span>
      <Badge tone="neutral" className="hidden sm:inline-flex">
        {SOURCE_LABEL[item.source] ?? item.source}
      </Badge>

      <button
        type="button"
        onClick={() => {
          setDecided('accept');
          onAccept();
        }}
        aria-label={`接受标签 ${item.tagName}`}
        className="ml-0.5 rounded p-1 text-ink-faint transition-colors hover:bg-positive-soft hover:text-positive-ink"
      >
        <Check size={12} />
      </button>
      <button
        type="button"
        onClick={() => {
          setDecided('reject');
          onReject();
        }}
        aria-label={`忽略标签 ${item.tagName}`}
        className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
      >
        <X size={12} />
      </button>
    </span>
  );
}

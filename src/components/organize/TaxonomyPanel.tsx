import { useState } from 'react';
import { ArrowRight, Combine, History, ShieldCheck, Trash2 } from 'lucide-react';
import type { AiTaxonomyAudit } from '@shared/types';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Skeleton } from '@/components/ui';
import { useBulkDeleteTags, useDeleteTag, useMergeLog, useMergeTags } from '@/hooks/queries';
import { formatDate } from '@/lib/url';
import { AliasSuggestions } from './AliasSuggestions';

/**
 * Taxonomy health: duplicate clusters, unused tags, low-usage tags, and the
 * merge audit trail — the tag governance panel (T1).
 *
 * ## Why this belongs to the AI feature
 *
 * Normalising each new proposal against the existing vocabulary stops *new*
 * duplicates appearing, but it does nothing about the four hundred tags a
 * browser import already dumped into the library. Detection and cleanup are
 * the same problem, and the same normalisation code answers both — so the
 * audit reuses it rather than asking the user to eyeball hundreds of rows.
 *
 * Execution deliberately reuses the existing tag endpoints (`/api/tags/merge`,
 * `DELETE /api/tags/:id`, `/api/tags/bulk-delete`): one code path rewrites tag
 * links, no matter who proposed the change. "Merge all" sends every cluster in
 * a single batch request, so it either all happens or none of it does — no
 * half-merged library if the network drops mid-way.
 */

interface Props {
  audit: AiTaxonomyAudit | undefined;
  loading?: boolean;
}

export function TaxonomyPanel({ audit, loading }: Props) {
  const merge = useMergeTags();
  const deleteTag = useDeleteTag();
  const bulkDelete = useBulkDeleteTags();
  /**
   * Tag queued for deletion. Deleting a tag is irreversible, and TagsPage
   * already gates the same action behind a confirmation — doing it silently
   * here would leave the user with two different mental models for one verb.
   */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  /** Bulk-clear confirmation for the whole unused list. */
  const [pendingClearAll, setPendingClearAll] = useState(false);

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (!audit) return null;

  const clean =
    audit.clusters.length === 0 && audit.unused.length === 0 && audit.lowUsage.length === 0;

  if (clean) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={<ShieldCheck size={22} />}
          title="标签体系很干净"
          description={`共 ${audit.totalTags} 个标签，没有发现重复、未使用或低频的标签。`}
        />
        <AliasSuggestions />
        <MergeHistory />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {audit.clusters.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="font-display text-sm font-semibold tracking-tight text-ink">疑似重复</h3>
            <Badge tone="caution">{audit.clusters.length}</Badge>
            {audit.clusters.length > 1 && (
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<Combine size={13} />}
                loading={merge.isPending}
                onClick={() =>
                  merge.mutate({
                    clusters: audit.clusters.map((c) => ({
                      sourceIds: c.duplicates.map((d) => d.id),
                      targetId: c.canonicalId,
                    })),
                  })
                }
              >
                一键全部合并
              </Button>
            )}
          </div>
          <p className="text-2xs text-ink-faint">
            合并后，重复标签下的书签会转移到保留标签，重复标签本身被删除。
          </p>

          <ul className="flex flex-col gap-2">
            {audit.clusters.map((cluster) => (
              <li
                key={cluster.canonicalId}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-surface p-3"
              >
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  {cluster.duplicates.map((dup) => (
                    <span
                      key={dup.id}
                      className="inline-flex h-6 items-center gap-1 rounded bg-sunken px-2 text-2xs text-ink-soft"
                    >
                      {dup.name}
                      <span className="tabular-nums text-ink-faint">{dup.count}</span>
                    </span>
                  ))}
                  <ArrowRight size={13} className="shrink-0 text-ink-faint" aria-hidden />
                  {/* The most-used member wins: it is the one already wired
                      into the user's habits and saved filters. */}
                  <span className="inline-flex h-6 items-center gap-1 rounded bg-brand-soft px-2 text-2xs font-medium text-brand-ink">
                    {cluster.canonicalName}
                    <span className="tabular-nums opacity-70">{cluster.canonicalCount}</span>
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <span className="hidden text-2xs text-ink-faint sm:inline">{cluster.reason}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    iconLeft={<Combine size={14} />}
                    loading={merge.isPending}
                    onClick={() =>
                      merge.mutate({
                        sourceIds: cluster.duplicates.map((d) => d.id),
                        targetId: cluster.canonicalId,
                      })
                    }
                  >
                    合并
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {audit.unused.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="font-display text-sm font-semibold tracking-tight text-ink">未使用</h3>
            <Badge tone="neutral">{audit.unused.length}</Badge>
            {audit.unused.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<Trash2 size={13} />}
                onClick={() => setPendingClearAll(true)}
              >
                全部清理
              </Button>
            )}
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {audit.unused.map((tag) => (
              <li key={tag.id}>
                <span className="inline-flex h-7 items-center gap-1 rounded-md border border-line pl-2 pr-1 text-2xs text-ink-soft">
                  {tag.name}
                  <IconButton
                    size="sm"
                    variant="danger"
                    label={`删除标签 ${tag.name}`}
                    icon={<Trash2 size={12} />}
                    onClick={() => setPendingDelete({ id: tag.id, name: tag.name })}
                    className="h-5 w-5"
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {audit.lowUsage.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="font-display text-sm font-semibold tracking-tight text-ink">低频标签</h3>
            <Badge tone="neutral">{audit.lowUsage.length}</Badge>
          </div>
          <p className="text-2xs text-ink-faint">
            只关联了 1 个书签的标签——考虑合并到更通用的标签，或保留作为细分。
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {audit.lowUsage.map((tag) => (
              <li key={tag.id}>
                <span className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-2xs text-ink-soft">
                  {tag.name}
                  <span className="tabular-nums text-ink-faint">1</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AliasSuggestions />

      <MergeHistory />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteTag.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
        title="删除标签"
        message={
          pendingDelete
            ? `确定删除标签「${pendingDelete.name}」吗？该标签当前没有关联任何书签，删除后无法撤销。`
            : ''
        }
        confirmLabel="删除"
        tone="danger"
        loading={deleteTag.isPending}
      />

      <ConfirmDialog
        open={pendingClearAll}
        onClose={() => setPendingClearAll(false)}
        onConfirm={() => {
          bulkDelete.mutate(audit.unused.map((t) => t.id));
          setPendingClearAll(false);
        }}
        title="清理全部未使用标签"
        message={`确定删除全部 ${audit.unused.length} 个未使用标签吗？它们都没有关联书签，删除后无法撤销。`}
        confirmLabel="全部删除"
        tone="danger"
        loading={bulkDelete.isPending}
      />
    </div>
  );
}

/**
 * The merge audit trail. Every merge writes a row server-side (names are
 * snapshotted because the merged-away tags no longer exist), so this list is
 * the user-visible proof that governance actions are traceable.
 */
function MergeHistory() {
  const { data: log, isLoading } = useMergeLog();

  if (isLoading) {
    return <Skeleton className="h-12 w-full rounded-md" />;
  }
  if (!log || log.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <History size={13} className="text-ink-faint" aria-hidden />
        <h3 className="font-display text-sm font-semibold tracking-tight text-ink">合并历史</h3>
        <Badge tone="neutral">{log.length}</Badge>
      </div>
      <ul className="flex flex-col gap-1">
        {log.slice(0, 10).map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-surface px-3 py-2 text-2xs text-ink-soft"
          >
            <span className="text-ink-faint">{formatDate(entry.createdAt)}</span>
            <span className="line-through opacity-70">{entry.sourceTagNames.join('、')}</span>
            <ArrowRight size={11} className="shrink-0 text-ink-faint" aria-hidden />
            <span className="font-medium text-ink">{entry.targetTagName}</span>
            <span className="tabular-nums text-ink-faint">×{entry.mergedCount}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

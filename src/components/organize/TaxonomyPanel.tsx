import { useState } from 'react';
import { ArrowRight, Combine, ShieldCheck, Trash2 } from 'lucide-react';
import type { AiTaxonomyAudit } from '@shared/types';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Skeleton } from '@/components/ui';
import { useDeleteTag, useMergeTags } from '@/hooks/queries';

/**
 * Taxonomy health: duplicate clusters and unused tags.
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
 * `DELETE /api/tags/:id`): one code path rewrites tag links, no matter who
 * proposed the change.
 */

interface Props {
  audit: AiTaxonomyAudit | undefined;
  loading?: boolean;
}

export function TaxonomyPanel({ audit, loading }: Props) {
  const merge = useMergeTags();
  const deleteTag = useDeleteTag();
  /**
   * Tag queued for deletion. Deleting a tag is irreversible, and TagsPage
   * already gates the same action behind a confirmation — doing it silently
   * here would leave the user with two different mental models for one verb.
   */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

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

  const clean = audit.clusters.length === 0 && audit.unused.length === 0;

  if (clean) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title="标签体系很干净"
        description={`共 ${audit.totalTags} 个标签，没有发现重复或未使用的标签。`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {audit.clusters.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-ink">疑似重复</h3>
            <Badge tone="caution">{audit.clusters.length}</Badge>
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
            <h3 className="text-xs font-semibold text-ink">未使用</h3>
            <Badge tone="neutral">{audit.unused.length}</Badge>
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
    </div>
  );
}

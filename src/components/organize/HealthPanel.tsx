import { useMemo, useState } from 'react';
import { Activity, Link2Off, Tag as TagIcon, Trash2, Zap } from 'lucide-react';
import type { HealthDuplicateGroup, ProbeResult } from '@shared/types';
import { Badge, Button, Skeleton } from '@/components/ui';
import { useHealthReport, useProbeBookmarks } from '@/hooks/queries/health';
import { useTrashBookmarks, useDeleteTag, useBookmarks } from '@/hooks/queries';
import { displayHost } from '@/lib/url';
import { cx } from '@/lib/cx';

/**
 * O1 — Library health panel.
 *
 * Three sections, each with its own safety posture:
 *   1. Score + structural summary (read-only, instant).
 *   2. Duplicate groups — "keep oldest, trash the rest" per group. Trashing
 *      (not purging) keeps the recycle bin as the undo path.
 *   3. Orphan tags — delete one by one; a tag with no bookmarks is safe to
 *      remove, but the action is still explicit per tag.
 *   4. Dead-link probe — runs against the currently visible library page in
 *      bounded batches; results are advisory (only 404/410 counts as dead).
 */
export function HealthPanel() {
  const { data: report, isLoading, isError, refetch } = useHealthReport();
  const trash = useTrashBookmarks();
  const deleteTag = useDeleteTag();
  const probe = useProbeBookmarks();

  const [probeResults, setProbeResults] = useState<ProbeResult[]>([]);
  const [probing, setProbing] = useState(false);

  // Probe targets come from the live library (first page); the endpoint caps
  // the batch server-side, so we just hand over what we have.
  const { data: library } = useBookmarks({ scope: 'all', limit: 20 }, true);
  const probeTargets = useMemo(
    () => (library?.pages ?? []).flatMap((p) => p.items).map((b) => b.id),
    [library],
  );

  const runProbe = async () => {
    if (probeTargets.length === 0) return;
    setProbing(true);
    setProbeResults([]);
    try {
      // Probe in batches of 20 (the server cap) so a page of results accrues.
      const acc: ProbeResult[] = [];
      for (let i = 0; i < probeTargets.length; i += 20) {
        const res = await probe.mutateAsync(probeTargets.slice(i, i + 20));
        acc.push(...res.results);
        setProbeResults([...acc]);
      }
    } finally {
      setProbing(false);
    }
  };

  const trashDuplicates = (group: HealthDuplicateGroup) => {
    // Keep the oldest copy (first in the ascending-created list), trash the rest.
    const extras = group.bookmarks.slice(1).map((b) => b.id);
    if (extras.length > 0) trash.mutate(extras);
  };

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface/85 p-5 shadow-raised backdrop-blur-sm">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-10 w-full" />
      </section>
    );
  }

  if (isError || !report) {
    return (
      <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface/85 p-5 shadow-raised backdrop-blur-sm">
        <p className="text-sm text-ink-soft">健康报告加载失败。</p>
        <Button size="sm" variant="secondary" onClick={() => void refetch()}>
          重试
        </Button>
      </section>
    );
  }

  const deadCount = probeResults.filter((r) => r.status === 'dead').length;
  const suspiciousCount = probeResults.filter((r) => r.status === 'suspicious').length;

  return (
    <section className="spotlight flex flex-col gap-4 rounded-xl border border-line bg-surface/85 p-5 shadow-raised backdrop-blur-sm">
      {/* Score header */}
      <div className="flex items-center gap-3">
        <Activity size={15} className="text-brand-accent" aria-hidden />
        <h3 className="font-display text-[0.95rem] font-semibold tracking-tight text-ink">书签库健康</h3>
        <span className="ml-auto flex items-center gap-2">
          <span
            className={cx(
              'text-lg font-bold tabular-nums',
              report.score >= 90
                ? 'text-positive'
                : report.score >= 70
                  ? 'text-caution'
                  : 'text-critical',
            )}
          >
            {report.score}
          </span>
          <span className="text-2xs text-ink-faint">/ 100</span>
        </span>
      </div>
      <p className="text-2xs leading-relaxed text-ink-faint">
        共 {report.liveTotal} 条有效书签。分数只反映结构性问题（重复与孤儿标签）；失效链接需单独探测。
      </p>

      {/* Duplicates */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Link2Off size={14} className="text-ink-faint" aria-hidden />
          <span className="text-xs font-medium text-ink">重复书签</span>
          {report.duplicateExtra > 0 && (
            <Badge tone="caution">{report.duplicateExtra} 条冗余</Badge>
          )}        </div>
        {report.duplicateGroups.length === 0 ? (
          <p className="text-2xs text-ink-faint">没有发现重复。</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {report.duplicateGroups.slice(0, 8).map((g) => (
              <li
                key={g.urlKey}
                className="flex items-center gap-2 rounded-md border border-line/60 bg-sunken/40 px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-2xs text-ink-soft" title={g.urlKey}>
                  {displayHost(g.bookmarks[0]?.url ?? g.urlKey)} · {g.count} 份
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  iconLeft={<Trash2 size={13} />}
                  loading={trash.isPending}
                  onClick={() => trashDuplicates(g)}
                >
                  保留最早，清理其余
                </Button>
              </li>
            ))}
            {report.duplicateGroups.length > 8 && (
              <li className="text-2xs text-ink-faint">
                还有 {report.duplicateGroups.length - 8} 组…
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Orphan tags */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <TagIcon size={14} className="text-ink-faint" aria-hidden />
          <span className="text-xs font-medium text-ink">孤儿标签</span>
          {report.orphanTags.length > 0 && <Badge tone="caution">{report.orphanTags.length}</Badge>}
        </div>
        {report.orphanTags.length === 0 ? (
          <p className="text-2xs text-ink-faint">每个标签都至少有一条书签。</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {report.orphanTags.slice(0, 20).map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={deleteTag.isPending}
                onClick={() => deleteTag.mutate(t.id)}
                className="group flex items-center gap-1 rounded-full border border-line bg-sunken/40 px-2 py-0.5 text-2xs text-ink-soft transition-colors hover:border-critical/40 hover:text-critical"
                title={`删除空标签「${t.name}」`}
              >
                {t.name}
                <Trash2 size={11} className="opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
              </button>
            ))}
            {report.orphanTags.length > 20 && (
              <span className="text-2xs text-ink-faint">+{report.orphanTags.length - 20}</span>
            )}
          </div>
        )}
      </div>

      {/* Dead-link probe */}
      <div className="flex flex-col gap-2 border-t border-line/60 pt-3">
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-ink-faint" aria-hidden />
          <span className="text-xs font-medium text-ink">失效链接探测</span>
          {probeResults.length > 0 && (
            <span className="text-2xs tabular-nums text-ink-faint">
              已查 {probeResults.length} 条
              {deadCount > 0 && <span className="text-critical"> · {deadCount} 失效</span>}
              {suspiciousCount > 0 && <span className="text-caution"> · {suspiciousCount} 存疑</span>}
            </span>
          )}
        </div>
        <p className="text-2xs leading-relaxed text-ink-faint">
          对当前书签逐批发起访问请求，仅 404/410 判定为失效；需要登录或临时故障的页面只标记为存疑，不会误删。
        </p>
        <div>
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<Zap size={13} />}
            onClick={() => void runProbe()}
            loading={probing}
            disabled={probeTargets.length === 0}
          >
            {probing ? '探测中…' : '探测前 20 条书签'}
          </Button>
        </div>
        {probeResults.length > 0 && (
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {probeResults
              .filter((r) => r.status !== 'ok')
              .map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-2xs">
                  <Badge tone={r.status === 'dead' ? 'critical' : 'caution'}>
                    {r.status === 'dead' ? '失效' : r.status === 'auth' ? '需登录' : '存疑'}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-ink-soft" title={r.url}>
                    {displayHost(r.url)}
                    {r.httpStatus !== null && ` · HTTP ${r.httpStatus}`}
                  </span>
                </li>
              ))}
            {probeResults.every((r) => r.status === 'ok') && (
              <li className="text-2xs text-positive">这批书签都能正常访问。</li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

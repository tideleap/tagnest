import { useMemo, useState } from 'react';
import { Sparkles, Tags } from 'lucide-react';
import { Badge, Button, EmptyState, Skeleton } from '@/components/ui';
import { useAiAliasSuggestions, useApplyAliases, useGenerateAliases } from '@/hooks/queries/organize';

/**
 * Alias expansion for the taxonomy health page.
 *
 * Surfaces offline synonym proposals (from the seed synonym table) and, on
 * demand, AI-generated ones, then writes the user-confirmed spellings into
 * `tags.aliases`. That column is already consumed by the normaliser, so the
 * net effect is future "前端 / Frontend / front-end" variants collapsing to one
 * tag without the user ever seeing the duplicates.
 *
 * Also renders the topic distribution of the pending suggestion queue — the
 * lightweight clustering the model produces per bookmark (Phase 1) surfaced as
 * a one-glance "what did this run touch?" view.
 */
export function AliasSuggestions() {
  const { data, isLoading } = useAiAliasSuggestions();
  const apply = useApplyAliases();
  const generate = useGenerateAliases();
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});

  if (isLoading) return <Skeleton className="h-20 w-full rounded-md" />;

  const suggestions = data?.aliasSuggestions ?? [];
  if (suggestions.length === 0) {
    return (
      <EmptyState
        icon={<Tags size={20} />}
        title="暂无别名建议"
        description="标签体系已较完整，或点击「用 AI 生成更多」获取同义词建议。"
      />
    );
  }

  const toggle = (tagId: string, alias: string) => {
    setPicked((prev) => {
      const next = { ...prev };
      const set = new Set(next[tagId] ?? []);
      if (set.has(alias)) set.delete(alias);
      else set.add(alias);
      next[tagId] = set;
      return next;
    });
  };

  const selectedItems = useMemo(
    () =>
      suggestions
        .map((s) => ({ tagId: s.tagId, aliases: [...(picked[s.tagId] ?? [])] }))
        .filter((i) => i.aliases.length > 0),
    [suggestions, picked],
  );

  const topicClusters = data?.topicClusters ?? [];

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-ink">别名建议</h3>
          <Badge tone="neutral">{suggestions.length}</Badge>
        </div>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<Sparkles size={14} />}
          loading={generate.isPending}
          onClick={() => generate.mutate(undefined)}
        >
          用 AI 生成更多
        </Button>
      </div>
      <p className="text-2xs text-ink-faint">
        将同义词写入标签，后续 AI 整理会自动合并相近表达，减少重复标签。
      </p>

      <ul className="flex flex-col gap-2">
        {suggestions.map((s) => (
          <li key={s.tagId} className="rounded-md border border-line bg-surface p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-2xs font-medium text-ink">{s.tagName}</span>
              <span className="text-2xs text-ink-faint">{s.reason}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {s.aliases.map((a) => {
                const active = picked[s.tagId]?.has(a);
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => toggle(s.tagId, a)}
                    className={`h-6 rounded px-2 text-2xs transition ${
                      active
                        ? 'bg-brand-soft text-brand-ink'
                        : 'bg-sunken text-ink-soft hover:text-ink'
                    }`}
                  >
                    {a}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={apply.isPending}
          disabled={selectedItems.length === 0}
          onClick={() => apply.mutate(selectedItems)}
        >
          应用到标签体系{selectedItems.length > 0 ? `（${selectedItems.length}）` : ''}
        </Button>
        {data?.modelAvailable === false && (
          <span className="text-2xs text-ink-faint">当前为离线建议；配置模型后可生成更丰富同义词。</span>
        )}
      </div>

      {topicClusters.length > 0 && (
        <div className="mt-1">
          <h4 className="mb-1 text-2xs font-semibold text-ink">本次整理主题分布</h4>
          <div className="flex flex-wrap gap-1.5">
            {topicClusters.slice(0, 12).map((c) => (
              <span
                key={c.topic}
                className="inline-flex h-6 items-center gap-1 rounded bg-sunken px-2 text-2xs text-ink-soft"
                title={`${c.tagNames.join('、')}`}
              >
                {c.topic}
                <span className="tabular-nums text-ink-faint">{c.bookmarkCount}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

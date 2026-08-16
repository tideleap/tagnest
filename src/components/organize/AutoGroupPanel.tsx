import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FolderTree } from 'lucide-react';
import { Button, Skeleton } from '@/components/ui';
import { useTags, useAutoGroupTags } from '@/hooks/queries';
import type { Tag } from '@shared/types';
import { cx } from '@/lib/cx';

/**
 * 「自动建组」— runs the backend 一级→二级→三级 grouping on the user's tags and
 * shows the resulting tree for review. The hierarchy is built on `tags.parent_id`
 * (which the tags table already supports), so nothing here is destructive: the
 * user can always re-parent a tag, and every tier is collapsible.
 */
export function AutoGroupPanel() {
  const { data: tags, isLoading } = useTags();
  const group = useAutoGroupTags();
  const [applied, setApplied] = useState<Tag[] | null>(null);

  const tree = useMemo(() => buildTree(applied ?? tags ?? []), [applied, tags]);

  const run = () => {
    group.mutate(undefined, {
      onSuccess: (result) => {
        setApplied(result.tags);
        setExpandedTop(new Set(result.tags.filter((t) => t.parentId === null).map((t) => t.id)));
      },
    });
  };

  const [expandedTop, setExpandedTop] = useState<Set<string>>(new Set());

  return (
    <section className="spotlight flex flex-col gap-3 rounded-xl border border-line bg-surface/85 p-5 shadow-raised backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <FolderTree size={15} className="text-brand-accent" aria-hidden />
        <h3 className="font-display text-[0.95rem] font-semibold tracking-tight text-ink">自动建组</h3>
        <span className="ml-auto" />
        <Button
          variant="secondary"
          iconLeft={<FolderTree size={14} />}
          onClick={run}
          loading={group.isPending}
        >
          {applied ? '重新建组' : '一键建组'}
        </Button>
      </div>
      <p className="text-2xs leading-relaxed text-ink-faint">
        将标签整理为「一级分类 → 二级子分类 → 三级标签」的层级结构。未匹配的标签保持原位；已深嵌套的三级标签不再下钻。
      </p>

      {group.data && (
        <p className="text-2xs text-ink-soft">
          新建 {group.data.createdCategories} 个分类 · 调整 {group.data.relocated} 个标签 ·{' '}
          {group.data.untouched} 个保持原位
        </p>
      )}

      {isLoading && !tags ? (
        <Skeleton className="h-24 w-full" />
      ) : tree.length === 0 ? (
        <p className="text-2xs text-ink-faint">还没有可归类的标签。</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto scrollbar-slim">
          {tree.map((top) => {
            const open = expandedTop.has(top.id);
            return (
              <li key={top.id} className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() =>
                    setExpandedTop((prev) => {
                      const next = new Set(prev);
                      if (next.has(top.id)) next.delete(top.id);
                      else next.add(top.id);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-2xs font-medium text-ink transition-colors hover:bg-surface-hover"
                >
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="min-w-0 truncate">{top.name}</span>
                  <span className="ml-auto tabular-nums text-ink-faint">{top.count}</span>
                </button>
                {open &&
                  top.children.map((child) => (
                    <ul key={child.id} className="ml-3 flex flex-col gap-0.5 border-l border-line pl-2">
                      {child.children.length === 0 ? (
                        <TagLeaf tag={child} />
                      ) : (
                        <>
                          <div className="flex w-full items-center gap-1.5 px-2 py-1 text-2xs text-ink-soft">
                            <ChevronRight size={12} className="text-ink-faint" />
                            <span className="min-w-0 truncate">{child.name}</span>
                            <span className="ml-auto tabular-nums text-ink-faint">{child.count}</span>
                          </div>
                          <ul className="flex flex-col gap-0.5">
                            {child.children.map((leaf) => (
                              <li key={leaf.id} className="ml-3">
                                <TagLeaf tag={leaf} />
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </ul>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TagLeaf({ tag }: { tag: Tag }) {
  return (
    <button
      type="button"
      title={tag.name}
      className={cx(
        'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-2xs text-ink-soft',
        'transition-colors hover:bg-surface-hover',
      )}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--tag-dot)]" style={tagDot(tag)} />
      <span className="min-w-0 truncate">{tag.name}</span>
      <span className="ml-auto tabular-nums text-ink-faint">{tag.count}</span>
    </button>
  );
}

function tagDot(tag: Tag) {
  // Palette slot 0-7; approximate a hue without importing the theme internals.
  const hues = [24, 200, 320, 150, 40, 260, 10, 190];
  const hue = hues[tag.colorIndex % hues.length];
  return { backgroundColor: `hsl(${hue} 70% 52%)` } as React.CSSProperties;
}

/** Builds a 3-level tree from the flat tag list (via parent_id). */
function buildTree(tags: Tag[]) {
  const nodes = new Map<string, TreeNode>();
  for (const t of tags) nodes.set(t.id, { ...t, children: [] });
  const tops: TreeNode[] = [];
  for (const t of tags) {
    const node = nodes.get(t.id)!;
    if (t.parentId && nodes.has(t.parentId)) nodes.get(t.parentId)!.children.push(node);
    else tops.push(node);
  }
  return tops;
}

interface TreeNode extends Tag {
  children: TreeNode[];
}

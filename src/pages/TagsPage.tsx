import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Combine,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react';
import type { Tag } from '@shared/types';
import {
  Button,
  ColorPicker,
  ConfirmDialog,
  DialogFooter,
  EmptyState,
  IconButton,
  Input,
  Menu,
  Modal,
  PageHeader,
  QueryErrorState,
  Select,
  Skeleton,
  Switch,
  TagChip,
  tagColorVars,
} from '@/components/ui';
import { useCreateTag, useDeleteTag, useMergeTags, useSetTagPrivate, useTags, useUpdateTag } from '@/hooks/queries';
import { cx } from '@/lib/cx';
import {
  buildTagTree,
  filterTagTree,
  type TagSortKey,
  type TreeNode,
} from '@/components/tags/buildTagTree';

export function TagsPage() {
  const navigate = useNavigate();
  const { data: tags, isLoading, isError, error, refetch } = useTags();

  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<TagSortKey>('count');
  const [editing, setEditing] = useState<Tag | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const [mergeSource, setMergeSource] = useState<Tag | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const deleteTag = useDeleteTag();
  const setTagPrivate = useSetTagPrivate();

  // Grouped forest (reuses the same builder as the sidebar nav tree) so the
  // page and the nav never disagree about hierarchy.
  const tree = useMemo(() => buildTagTree(tags ?? [], sortKey), [tags, sortKey]);
  const filtered = useMemo(() => filterTagTree(tree, filter), [tree, filter]);

  // Expand top-level groups by default once the list loads.
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const top of tree) if (top.children.length > 0) next.add(top.id);
      return next;
    });
  }, [tree]);

  const unused = (tags ?? []).filter((t) => t.count === 0);

  const togglePrivate = (tag: Tag) =>
    setTagPrivate.mutate({ id: tag.id, isPrivate: !tag.isPrivate });
  const goToTag = (id: string) => navigate(`/library/all?tagIds=${encodeURIComponent(id)}`);
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={<TagIcon size={14} aria-hidden />}
        eyebrow="整理分类"
        title="标签"
        description="按分组管理你的标签词汇表——把书签收进一致的层级，合并、重命名或清理从不使用的标签。"
      >
        {tags && (
          <span className="mr-1 text-xs tabular-nums text-ink-faint">{tags.length} 个</span>
        )}
        <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setCreating(true)}>
          新建标签
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选标签…"
          aria-label="筛选标签"
          size="sm"
          containerClassName="w-full sm:w-56"
        />
        <Select
          aria-label="排序方式"
          size="sm"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as TagSortKey)}
          options={[
            { value: 'count', label: '按使用量' },
            { value: 'name', label: '按名称' },
            { value: 'recent', label: '按创建时间' },
          ]}
          containerClassName="w-32"
        />
        {unused.length > 0 && (
          <span className="ml-auto text-xs text-ink-faint">{unused.length} 个标签暂未使用</span>
        )}
      </div>

      {isLoading ? (
        <ul className="flex flex-col gap-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i}>
              <Skeleton className="h-12 w-full rounded-md" />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <QueryErrorState
          message={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<TagIcon size={22} />}
          title={filter ? '没有匹配的标签' : '还没有标签'}
          description={
            filter ? '换个关键词试试。' : '标签是找回书签最快的方式，先给几条常用的书签打上标签。'
          }
          action={
            !filter ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                新建标签
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {filtered.map((top) => (
            <GroupRow
              key={top.id}
              node={top}
              depth={0}
              expanded={expanded}
              onToggleExpand={toggleExpand}
              onNavigate={goToTag}
              onSetPrivate={togglePrivate}
              onRename={setEditing}
              onMerge={setMergeSource}
              onDelete={setDeleting}
              totalCount={tags?.length ?? 0}
            />
          ))}
        </ul>
      )}

      <TagFormDialog
        open={creating || editing !== null}
        tag={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />

      <MergeDialog
        source={mergeSource}
        candidates={(tags ?? []).filter((t) => t.id !== mergeSource?.id)}
        onClose={() => setMergeSource(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deleteTag.mutate(deleting.id);
          setDeleting(null);
        }}
        title={`删除标签「${deleting?.name}」？`}
        message={
          deleting && deleting.count > 0
            ? `${deleting.count} 个书签会失去这个标签，但书签本身不会被删除。`
            : '这个标签还没有被使用，删除不影响任何书签。'
        }
        confirmLabel="删除"
        tone="danger"
        loading={deleteTag.isPending}
      />
    </div>
  );
}

function GroupRow({
  node,
  depth,
  expanded,
  onToggleExpand,
  onNavigate,
  onSetPrivate,
  onRename,
  onMerge,
  onDelete,
  totalCount,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  onNavigate: (id: string) => void;
  onSetPrivate: (tag: Tag) => void;
  onRename: (tag: Tag) => void;
  onMerge: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
  totalCount: number;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const indent = depth * 14;

  return (
    <li className="flex flex-col">
      <div
        className={cx(
          'group flex w-full items-center gap-2 rounded-md border border-line bg-surface px-2 py-2 transition-colors hover:border-line-strong',
          isOpen && 'bg-surface-hover/40',
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.id)}
            className="shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
            aria-label={isOpen ? '收起分组' : '展开分组'}
            aria-expanded={isOpen}
          >
            {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : (
          <span className="w-6" />
        )}

        <span
          style={tagColorVars(node.colorIndex)}
          className="relative h-7 w-7 shrink-0 rounded-md bg-[var(--tag-bg)]"
          aria-hidden
        >
          {node.isPrivate && (
            <span
              title="私密"
              className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-surface bg-ink text-surface"
            >
              <Lock size={9} />
            </span>
          )}
        </span>

        <button
          type="button"
          onClick={() => onNavigate(node.id)}
          className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink transition-colors hover:text-brand-ink"
        >
          {node.name}
        </button>

        <span className="shrink-0 text-2xs tabular-nums text-ink-faint">
          {node.count} 个书签
        </span>

        <Switch
          checked={node.isPrivate}
          onChange={() => onSetPrivate(node)}
          label={node.isPrivate ? `取消「${node.name}」私密` : `将「${node.name}」设为私密`}
          labelHidden
        />

        <Menu
          align="end"
          width={180}
          trigger={(props) => (
            <IconButton
              {...props}
              label={`${node.name} 的操作`}
              size="sm"
              icon={<MoreHorizontal size={16} />}
              className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
            />
          )}
          items={[
            {
              id: 'rename',
              label: '重命名 / 改色',
              icon: <Pencil size={15} />,
              onSelect: () => onRename(node),
            },
            {
              id: 'merge',
              label: '合并到其他标签',
              icon: <Combine size={15} />,
              disabled: totalCount < 2,
              onSelect: () => onMerge(node),
            },
            {
              id: 'private',
              label: node.isPrivate ? '取消私密' : '设为私密',
              icon: <Lock size={15} />,
              onSelect: () => onSetPrivate(node),
            },
            {
              id: 'delete',
              label: '删除标签',
              icon: <Trash2 size={15} />,
              tone: 'danger',
              separatorBefore: true,
              onSelect: () => onDelete(node),
            },
          ]}
        />
      </div>

      {hasChildren && isOpen && (
        <ul className="flex flex-col">
          {node.children.map((child) => (
            <GroupRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onNavigate={onNavigate}
              onSetPrivate={onSetPrivate}
              onRename={onRename}
              onMerge={onMerge}
              onDelete={onDelete}
              totalCount={totalCount}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TagFormDialog({
  open,
  tag,
  onClose,
}: {
  open: boolean;
  tag: Tag | null;
  onClose: () => void;
}) {
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();

  const [name, setName] = useState('');
  const [colorIndex, setColorIndex] = useState(0);
  const [error, setError] = useState<string>();

  // Reset whenever the dialog target changes.
  const key = tag?.id ?? 'new';
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setName(tag?.name ?? '');
    setColorIndex(tag?.colorIndex ?? 0);
    setError(undefined);
  }

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('标签名不能为空');
      return;
    }
    if (tag) {
      updateTag.mutate({ id: tag.id, patch: { name: trimmed, colorIndex } }, { onSuccess: onClose });
    } else {
      createTag.mutate({ name: trimmed, colorIndex }, { onSuccess: onClose });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tag ? '编辑标签' : '新建标签'}
      size="sm"
      footer={
        <DialogFooter
          onCancel={onClose}
          onSubmit={submit}
          loading={createTag.isPending || updateTag.isPending}
          submitLabel={tag ? '保存' : '创建'}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          autoFocus
          label="名称"
          value={name}
          error={error}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="例如：设计参考"
        />

        <ColorPicker value={colorIndex} onChange={setColorIndex} />

        <div className="rounded-md bg-sunken px-3 py-2.5">
          <p className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-ink-faint">预览</p>
          <TagChip name={name.trim() || '标签名'} colorIndex={colorIndex} count={tag?.count} />
        </div>
      </div>
    </Modal>
  );
}

function MergeDialog({
  source,
  candidates,
  onClose,
}: {
  source: Tag | null;
  candidates: Tag[];
  onClose: () => void;
}) {
  const merge = useMergeTags();
  const [targetId, setTargetId] = useState('');

  return (
    <Modal
      open={source !== null}
      onClose={onClose}
      title={`合并「${source?.name}」`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!targetId}
            loading={merge.isPending}
            onClick={() => {
              if (!source || !targetId) return;
              merge.mutate({ sourceIds: [source.id], targetId }, { onSuccess: onClose });
            }}
          >
            合并
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-ink-soft">
          「{source?.name}」下的 {source?.count} 个书签会被转移到目标标签，然后「{source?.name}
          」会被删除。这一步无法撤销。
        </p>
        <Select
          label="合并到"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          options={[
            { value: '', label: '选择目标标签…' },
            ...candidates.map((t) => ({ value: t.id, label: `${t.name}（${t.count}）` })),
          ]}
        />
      </div>
    </Modal>
  );
}

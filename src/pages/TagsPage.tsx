import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Combine, Lock, Pencil, Plus, Tag as TagIcon, Trash2 } from 'lucide-react';
import type { Tag } from '@shared/types';
import { TAG_COLOR_COUNT } from '@shared/types';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Menu,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  TagChip,
  tagColorVars,
} from '@/components/ui';
import { useCreateTag, useDeleteTag, useMergeTags, useSetTagPrivate, useTags, useUpdateTag } from '@/hooks/queries';
import { cx } from '@/lib/cx';

type SortKey = 'count' | 'name' | 'recent';

export function TagsPage() {
  const navigate = useNavigate();
  const { data: tags, isLoading } = useTags();

  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('count');
  const [editing, setEditing] = useState<Tag | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const [mergeSource, setMergeSource] = useState<Tag | null>(null);

  const deleteTag = useDeleteTag();
  const setTagPrivate = useSetTagPrivate();

  const visible = useMemo(() => {
    const lower = filter.trim().toLowerCase();
    const list = (tags ?? []).filter((t) => (lower ? t.name.toLowerCase().includes(lower) : true));

    return list.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'zh-CN');
      if (sortKey === 'recent') return b.createdAt.localeCompare(a.createdAt);
      return b.count - a.count || a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [tags, filter, sortKey]);

  const unused = (tags ?? []).filter((t) => t.count === 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={<TagIcon size={14} aria-hidden />}
        eyebrow="整理分类"
        title="标签"
        description="把书签收进一致的词汇表——合并、重命名或清理从不使用的标签。"
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
          onChange={(e) => setSortKey(e.target.value as SortKey)}
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
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i}>
              <Skeleton className="h-16 w-full rounded-md" />
            </li>
          ))}
        </ul>
      ) : visible.length === 0 ? (
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
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((tag) => (
            <li key={tag.id}>
              <div
                className={cx(
                  'group flex items-center gap-3 rounded-md border border-line bg-surface p-3 transition-colors hover:border-line-strong',
                )}
              >
                <span
                  style={tagColorVars(tag.colorIndex)}
                  className="relative h-8 w-8 shrink-0 rounded-md bg-[var(--tag-bg)]"
                  aria-hidden
                >
                  {tag.isPrivate && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-surface bg-ink text-surface">
                      <Lock size={9} />
                    </span>
                  )}
                </span>

                <button
                  type="button"
                  onClick={() => navigate(`/library/all?tagIds=${encodeURIComponent(tag.id)}`)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-ink">{tag.name}</span>
                  <span className="block text-2xs tabular-nums text-ink-faint">
                    {tag.count} 个书签
                    {tag.isPrivate && <span className="ml-1 text-brand-ink">· 私密</span>}
                  </span>
                </button>

                <Menu
                  align="end"
                  width={170}
                  trigger={(props) => (
                    <IconButton
                      {...props}
                      label={`${tag.name} 的操作`}
                      size="sm"
                      icon={<Pencil size={14} />}
                      className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
                    />
                  )}
                  items={[
                    {
                      id: 'rename',
                      label: '重命名 / 改色',
                      icon: <Pencil size={15} />,
                      onSelect: () => setEditing(tag),
                    },
                    {
                      id: 'merge',
                      label: '合并到其他标签',
                      icon: <Combine size={15} />,
                      disabled: (tags?.length ?? 0) < 2,
                      onSelect: () => setMergeSource(tag),
                    },
                    {
                      id: 'private',
                      label: tag.isPrivate ? '取消私密' : '设为私密',
                      icon: <Lock size={15} />,
                      onSelect: () =>
                        setTagPrivate.mutate({ id: tag.id, isPrivate: !tag.isPrivate }),
                    },
                    {
                      id: 'delete',
                      label: '删除标签',
                      icon: <Trash2 size={15} />,
                      tone: 'danger',
                      separatorBefore: true,
                      onSelect: () => setDeleting(tag),
                    },
                  ]}
                />
              </div>
            </li>
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
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={createTag.isPending || updateTag.isPending}
          >
            {tag ? '保存' : '创建'}
          </Button>
        </>
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

        <div>
          <p className="mb-2 text-xs font-medium text-ink-soft">颜色</p>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: TAG_COLOR_COUNT }).map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setColorIndex(i)}
                aria-label={`颜色 ${i + 1}`}
                aria-pressed={colorIndex === i}
                style={tagColorVars(i)}
                className={cx(
                  'h-7 w-7 rounded-full border-2 bg-[var(--tag-dot)] transition-transform',
                  colorIndex === i
                    ? 'scale-110 border-ink'
                    : 'border-transparent hover:scale-105',
                )}
              />
            ))}
          </div>
        </div>

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

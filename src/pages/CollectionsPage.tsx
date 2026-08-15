import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Folder as FolderIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Collection } from '@shared/types';
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
  QueryErrorState,
  Skeleton,
  tagColorVars,
} from '@/components/ui';
import {
  useCollections,
  useCreateCollection,
  useDeleteCollection,
  useRenameCollection,
} from '@/hooks/queries';
import { cx } from '@/lib/cx';

export function CollectionsPage() {
  const navigate = useNavigate();
  const { data: collections, isLoading, isError, error, refetch } = useCollections();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Collection | null>(null);
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const deleteCollection = useDeleteCollection();

  const visible = useMemo(
    () => (collections ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [collections],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={<FolderIcon size={14} aria-hidden />}
        eyebrow="整理分类"
        title="集合"
        description="把书签收进持久、可分享的收藏夹——比标签更稳定，比标签页组更适合长期保存。一个书签可以属于多个集合。"
      >
        {collections && (
          <span className="mr-1 text-xs tabular-nums text-ink-faint">{collections.length} 个</span>
        )}
        <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setCreating(true)}>
          新建集合
        </Button>
      </PageHeader>

      {isLoading ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i}>
              <Skeleton className="h-20 w-full rounded-md" />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <QueryErrorState
          message={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<FolderIcon size={22} />}
          title="还没有集合"
          description="集合是一份持久、可分享的书签清单。新建一个，把常用的资料归在一起。"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              新建集合
            </Button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((c) => (
            <li key={c.id}>
              <div className="group flex items-center gap-3 rounded-md border border-line bg-surface p-3 transition-colors hover:border-line-strong">
                <button
                  type="button"
                  onClick={() => navigate(`/collections/${c.id}`)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span
                    style={tagColorVars(c.colorIndex)}
                    className="h-8 w-8 shrink-0 rounded-md bg-[var(--tag-bg)]"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{c.name}</span>
                    <span className="block text-2xs tabular-nums text-ink-faint">
                      {c.count} 个书签
                    </span>
                  </span>
                </button>

                <Menu
                  align="end"
                  width={180}
                  trigger={(props) => (
                    <IconButton
                      {...props}
                      label={`${c.name} 的操作`}
                      size="sm"
                      icon={<Pencil size={14} />}
                      className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
                    />
                  )}
                  items={[
                    {
                      id: 'open',
                      label: '打开集合',
                      icon: <FolderIcon size={15} />,
                      onSelect: () => navigate(`/collections/${c.id}`),
                    },
                    {
                      id: 'rename',
                      label: '重命名 / 改色',
                      icon: <Pencil size={15} />,
                      separatorBefore: true,
                      onSelect: () => setEditing(c),
                    },
                    {
                      id: 'delete',
                      label: '删除集合',
                      icon: <Trash2 size={15} />,
                      tone: 'danger',
                      separatorBefore: true,
                      onSelect: () => setDeleting(c),
                    },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <CollectionFormDialog
        open={creating || editing !== null}
        collection={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deleteCollection.mutate(deleting.id);
          setDeleting(null);
        }}
        title={`删除集合「${deleting?.name}」？`}
        message={
          deleting && deleting.count > 0
            ? `${deleting.count} 个书签会从集合中移除，但书签本身不会被删除。`
            : '这个集合还没有书签，删除不影响任何书签。'
        }
        confirmLabel="删除"
        tone="danger"
        loading={deleteCollection.isPending}
      />
    </div>
  );
}

function CollectionFormDialog({
  open,
  collection,
  onClose,
}: {
  open: boolean;
  collection: Collection | null;
  onClose: () => void;
}) {
  const create = useCreateCollection();
  const update = useRenameCollection();

  const [name, setName] = useState('');
  const [colorIndex, setColorIndex] = useState(0);
  const [error, setError] = useState<string>();

  // Reset whenever the dialog target changes.
  const key = collection?.id ?? 'new';
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setName(collection?.name ?? '');
    setColorIndex(collection?.colorIndex ?? 0);
    setError(undefined);
  }

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('集合名称不能为空');
      return;
    }
    if (collection) {
      update.mutate(
        { id: collection.id, patch: { name: trimmed, colorIndex } },
        { onSuccess: onClose },
      );
    } else {
      create.mutate({ name: trimmed, colorIndex }, { onSuccess: onClose });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={collection ? '编辑集合' : '新建集合'}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={create.isPending || update.isPending}
          >
            {collection ? '保存' : '创建'}
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
                  colorIndex === i ? 'scale-110 border-ink' : 'border-transparent hover:scale-105',
                )}
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

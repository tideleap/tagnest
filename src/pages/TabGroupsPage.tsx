import { useMemo, useState } from 'react';
import {
  ExternalLink,
  FolderOpen,
  GripVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { Bookmark, TabGroup, TabItem } from '@shared/types';
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
  QueryErrorState,
  Skeleton,
  tagColorVars,
} from '@/components/ui';
import {
  useAddTabItem,
  useCreateTabGroup,
  useDeleteTabGroup,
  useReorderTabItems,
  useRemoveTabItem,
  useTabGroup,
  useTabGroups,
  useUpdateTabGroup,
} from '@/hooks/queries';
import { api, qs } from '@/lib/api';
import { cx } from '@/lib/cx';

export function TabGroupsPage() {
  const { data: groups, isLoading, isError, error, refetch } = useTabGroups();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TabGroup | null>(null);
  const [deleting, setDeleting] = useState<TabGroup | null>(null);

  const deleteGroup = useDeleteTabGroup();

  const selected = groups?.find((g) => g.id === selectedId) ?? null;
  // Once groups load, auto-select the first if nothing is chosen yet.
  const effectiveSelected = selected ?? (groups && groups.length > 0 ? groups[0] : null);
  const activeId = selected?.id ?? effectiveSelected?.id ?? null;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
      {/* Group list */}
      <aside className="flex min-h-0 flex-col rounded-lg border border-line bg-surface">
        <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <h2 className="text-sm font-semibold text-ink">分组</h2>
          <IconButton
            label="新建分组"
            icon={<Plus size={16} />}
            size="sm"
            onClick={() => setCreating(true)}
          />
        </header>

        {isLoading ? (
          <ul className="flex flex-col gap-1 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i}>
                <Skeleton className="h-9 w-full rounded-md" />
              </li>
            ))}
          </ul>
        ) : isError ? (
          <div className="p-2">
            <QueryErrorState
              compact
              message={error instanceof Error ? error.message : undefined}
              onRetry={() => void refetch()}
            />
          </div>
        ) : (groups ?? []).length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-4 text-center">
            <p className="text-xs leading-relaxed text-ink-faint">
              还没有分组。把常用书签归到一个分组，方便一次性全部打开。
            </p>
          </div>
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-2">
            {groups!.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(g.id)}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                    activeId === g.id
                      ? 'bg-brand-soft text-brand-ink'
                      : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
                  )}
                >
                  <span
                    style={tagColorVars(g.colorIndex)}
                    className="h-3 w-3 shrink-0 rounded-full bg-[var(--tag-dot)]"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
                  <span className="shrink-0 text-2xs tabular-nums text-ink-faint">{g.count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Group detail */}
      <section className="min-h-0">
        {!activeId ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={<FolderOpen size={22} />}
              title="选择一个分组"
              description="左侧点击一个分组查看其中的书签，或新建一个分组开始整理。"
            />
          </div>
        ) : (
          <GroupDetail
            groupId={activeId}
            onRename={(g) => setEditing(g)}
            onDelete={(g) => setDeleting(g)}
            onAdd={() => setAdding(true)}
          />
        )}
      </section>

      <GroupFormDialog
        open={creating || editing !== null}
        group={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />

      <AddBookmarkDialog
        open={adding}
        groupId={activeId}
        onClose={() => setAdding(false)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deleteGroup.mutate(deleting.id);
          setDeleting(null);
          if (selectedId === deleting?.id) setSelectedId(null);
        }}
        title={`删除分组「${deleting?.name}」？`}
        message="分组内的书签不会被删除，只是从分组中移除。"
        confirmLabel="删除"
        tone="danger"
      />
    </div>
  );
}

function GroupDetail({
  groupId,
  onRename,
  onDelete,
  onAdd,
}: {
  groupId: string;
  onRename: (g: TabGroup) => void;
  onDelete: (g: TabGroup) => void;
  onAdd: () => void;
}) {
  const { data, isLoading } = useTabGroup(groupId);
  const removeItem = useRemoveTabItem();
  const reorder = useReorderTabItems();

  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const group = data?.group ?? null;
  const items = useMemo(() => data?.items ?? [], [data]);

  const openAll = () => {
    for (const it of items) {
      window.open(it.bookmark.url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      return;
    }
    const next = [...items];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    setDragIndex(null);
    reorder.mutate({ groupId, ids: next.map((i) => i.id) });
  };

  if (isLoading && !group) {
    return (
      <div className="flex h-full items-center justify-center">
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }
  if (!group) return null;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <span
          style={tagColorVars(group.colorIndex)}
          className="h-3.5 w-3.5 shrink-0 rounded-full bg-[var(--tag-dot)]"
          aria-hidden
        />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">{group.name}</h1>
        {items.length > 0 && (
          <Button variant="ghost" iconLeft={<ExternalLink size={15} />} onClick={openAll}>
            全部打开
          </Button>
        )}
        <Menu
          align="end"
          width={180}
          trigger={(props) => (
            <IconButton {...props} label="分组操作" size="sm" icon={<Pencil size={14} />} />
          )}
          items={[
            { id: 'rename', label: '重命名 / 改色', icon: <Pencil size={15} />, onSelect: () => onRename(group) },
            {
              id: 'delete',
              label: '删除分组',
              icon: <Trash2 size={15} />,
              tone: 'danger',
              separatorBefore: true,
              onSelect: () => onDelete(group),
            },
          ]}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-3">
        {items.length === 0 ? (
          <EmptyState
            icon={<FolderOpen size={22} />}
            title="这个分组还是空的"
            description="把已有的书签添加进来，整理成一份可一键打开的阅读清单。"
            action={<Button variant="primary" iconLeft={<Plus size={16} />} onClick={onAdd}>添加书签</Button>}
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item, index) => (
              <li
                key={item.id}
                draggable
                onDragStart={(e) => {
                  setDragIndex(index);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(index)}
                className={cx(
                  'group flex items-center gap-2.5 rounded-md border border-transparent px-2 py-2 transition-colors hover:border-line hover:bg-surface-hover',
                  dragIndex === index && 'opacity-50',
                )}
              >
                <span className="shrink-0 cursor-grab text-ink-faint" aria-hidden>
                  <GripVertical size={15} />
                </span>
                {item.bookmark.faviconUrl ? (
                  <img
                    src={item.bookmark.faviconUrl}
                    alt=""
                    className="h-4 w-4 shrink-0 rounded-sm"
                    loading="lazy"
                  />
                ) : (
                  <span className="h-4 w-4 shrink-0 rounded-sm bg-sunken" aria-hidden />
                )}
                <a
                  href={item.bookmark.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-ink hover:text-brand-ink hover:underline"
                  title={item.bookmark.title || item.bookmark.url}
                >
                  {item.bookmark.title || item.bookmark.url}
                </a>
                <IconButton
                  label="从分组移除"
                  icon={<X size={14} />}
                  size="sm"
                  className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
                  onClick={() => removeItem.mutate({ groupId, itemId: item.id })}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="border-t border-line px-4 py-2.5">
        <Button variant="primary" iconLeft={<Plus size={16} />} onClick={onAdd}>
          添加书签
        </Button>
      </footer>
    </div>
  );
}

function GroupFormDialog({
  open,
  group,
  onClose,
}: {
  open: boolean;
  group: TabGroup | null;
  onClose: () => void;
}) {
  const create = useCreateTabGroup();
  const update = useUpdateTabGroup();

  const [name, setName] = useState('');
  const [colorIndex, setColorIndex] = useState(0);
  const [error, setError] = useState<string>();

  const key = group?.id ?? 'new';
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setName(group?.name ?? '');
    setColorIndex(group?.colorIndex ?? 0);
    setError(undefined);
  }

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('分组名称不能为空');
      return;
    }
    if (group) {
      update.mutate({ id: group.id, patch: { name: trimmed, colorIndex } }, { onSuccess: onClose });
    } else {
      create.mutate({ name: trimmed, colorIndex }, { onSuccess: onClose });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={group ? '编辑分组' : '新建分组'}
      size="sm"
      footer={
        <DialogFooter
          onCancel={onClose}
          onSubmit={submit}
          loading={create.isPending || update.isPending}
          submitLabel={group ? '保存' : '创建'}
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
      </div>
    </Modal>
  );
}

/**
 * Picks an existing bookmark to add to the group.
 *
 * Groups only reference bookmarks that already live in the library, so there
 * is no creation path here — search and select. Bookmarks already in the group
 * are filtered out so the list never offers a duplicate.
 */
function AddBookmarkDialog({
  open,
  groupId,
  onClose,
}: {
  open: boolean;
  groupId: string | null;
  onClose: () => void;
}) {
  const addItem = useAddTabItem();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Bookmark[]>([]);
  const [inGroup, setInGroup] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const runSearch = async (q: string) => {
    if (!groupId) return;
    setLoading(true);
    try {
      const page = await api.get<{ items: Bookmark[] }>(
        `/bookmarks${qs({ scope: 'all', q: q.trim() || undefined, limit: 20, sort: 'created_desc' })}`,
      );
      setResults(page.items);
      setInGroup(new Set(page.items.filter(() => false).map((b) => b.id)));
      // Mark which results are already in this group by reading current group.
      const detail = await api.get<{ items: TabItem[] }>(`/tab-groups/${groupId}`);
      const ids = new Set(detail.items.map((i) => i.bookmarkId));
      setInGroup(ids);
    } finally {
      setLoading(false);
    }
  };

  // Reset whenever the dialog opens.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    setQuery('');
    setResults([]);
    setInGroup(new Set());
  }

  const pick = (b: Bookmark) => {
    if (!groupId) return;
    addItem.mutate(
      { groupId, bookmarkId: b.id },
      {
        onSuccess: () => {
          setResults((prev) => prev.filter((x) => x.id !== b.id));
          setInGroup((prev) => new Set(prev).add(b.id));
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="添加书签"
      size="sm"
      footer={
        <Button variant="ghost" onClick={onClose}>
          完成
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            void runSearch(e.target.value);
          }}
          placeholder="搜索书签…"
          aria-label="搜索书签"
          containerClassName="w-full"
          iconLeft={<Search size={15} className="text-ink-faint" />}
        />

        <div className="min-h-32 max-h-72 overflow-y-auto scrollbar-slim">
          {loading ? (
            <div className="space-y-1.5 p-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full rounded-md" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-ink-faint">
              {query ? '没有匹配的书签' : '输入关键词搜索你的书签'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {results.map((b) => {
                const added = inGroup.has(b.id);
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      disabled={added}
                      onClick={() => pick(b)}
                      className={cx(
                        'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors',
                        added
                          ? 'cursor-default text-ink-faint'
                          : 'hover:bg-surface-hover',
                      )}
                    >
                      {b.faviconUrl ? (
                        <img src={b.faviconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm" />
                      ) : (
                        <span className="h-4 w-4 shrink-0 rounded-sm bg-sunken" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate">{b.title || b.url}</span>
                      {added && <span className="shrink-0 text-2xs text-ink-faint">已添加</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

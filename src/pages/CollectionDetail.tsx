import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FolderPlus, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { Bookmark, Collection, SavedSearchQuery, Tag } from '@shared/types';
import { TAG_COLOR_COUNT } from '@shared/types';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Menu,
  Modal,
  PageHeader,
  Skeleton,
  tagColorVars,
} from '@/components/ui';
import {
  useAddToCollection,
  useCollection,
  useCreateCollection,
  useDeleteCollection,
  useRemoveFromCollection,
  useRenameCollection,
  useTags,
} from '@/hooks/queries';
import { api, qs } from '@/lib/api';
import { cx } from '@/lib/cx';
import { toast } from '@/components/ui/Toast';

const SCOPE_LABEL: Record<string, string> = {
  inbox: '收件箱',
  all: '全部',
  favorites: '收藏',
  archive: '归档',
  trash: '回收站',
};

const SORT_LABEL: Record<string, string> = {
  created_desc: '最新',
  created_asc: '最早',
  updated_desc: '最近更新',
  title_asc: '标题',
  visits_desc: '最多访问',
  manual: '手动',
};

/** Human-readable summary of a smart collection's saved query. */
function summarizeQuery(q: SavedSearchQuery, tags: Tag[] | undefined): string {
  const parts: string[] = [];
  if (q.q) parts.push(`“${q.q}”`);
  if (q.tagIds.length > 0) {
    const names = q.tagIds.map((id) => tags?.find((t) => t.id === id)?.name ?? id);
    parts.push(names.join(' · '));
  }
  parts.push(SCOPE_LABEL[q.scope] ?? q.scope);
  parts.push(SORT_LABEL[q.sort] ?? q.sort);
  if (q.matchAllTags && q.tagIds.length > 1) parts.push('需全部标签');
  return parts.join(' · ');
}

export function CollectionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useCollection(id ?? null);
  const { data: tags } = useTags();

  const remove = useRemoveFromCollection();
  const deleteCollection = useDeleteCollection();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Collection | null>(null);
  const [deleting, setDeleting] = useState<Collection | null>(null);

  const collection = data?.collection ?? null;
  const bookmarks = useMemo(() => data?.bookmarks ?? [], [data]);
  const existingIds = useMemo(() => new Set(bookmarks.map((b) => b.id)), [bookmarks]);
  const isSmart = collection?.kind === 'smart';

  if (isLoading && !collection) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-64 rounded-md" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  if (!collection) {
    return (
      <EmptyState
        icon={<FolderPlus size={22} />}
        title="集合不存在"
        description="它可能已被删除，或链接有误。"
        action={
          <Button variant="primary" onClick={() => navigate('/collections')}>
            返回集合列表
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/collections"
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-ink-soft transition-colors hover:text-brand-ink"
      >
        <ArrowLeft size={14} aria-hidden />
        集合
      </Link>

      <PageHeader
        icon={
          <span
            style={tagColorVars(collection.colorIndex)}
            className="h-3.5 w-3.5 rounded-full bg-[var(--tag-dot)]"
            aria-hidden
          />
        }
        eyebrow={isSmart ? '智能集合' : '集合'}
        index="09 / 16"
        title={collection.name}
        description={
          isSmart
            ? `智能集合 · 实时匹配 ${collection.count} 个书签`
            : collection.count > 0
              ? `${collection.count} 个书签`
              : '还没有书签'
        }
      >
        {!isSmart && (
          <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setAdding(true)}>
            添加书签
          </Button>
        )}
        <Menu
          align="end"
          width={180}
          trigger={(props) => (
            <IconButton {...props} label="集合操作" size="sm" icon={<Pencil size={14} />} />
          )}
          items={[
            {
              id: 'rename',
              label: '重命名 / 改色',
              icon: <Pencil size={15} />,
              onSelect: () => setEditing(collection),
            },
            {
              id: 'delete',
              label: '删除集合',
              icon: <Trash2 size={15} />,
              tone: 'danger',
              separatorBefore: true,
              onSelect: () => setDeleting(collection),
            },
          ]}
        />
      </PageHeader>

      {isSmart && collection.query && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
          <Badge tone="brand">实时</Badge>
          <span className="text-xs text-ink-soft">{summarizeQuery(collection.query, tags)}</span>
        </div>
      )}

      {bookmarks.length === 0 ? (
        <EmptyState
          icon={<FolderPlus size={22} />}
          title={isSmart ? '还没有匹配的书签' : '这个集合还是空的'}
          description={
            isSmart
              ? '当前搜索条件暂无匹配项。新增或调整书签后，这里会自动更新。'
              : '把已有的书签添加进来，整理成一份持久、可分享的清单。'
          }
          action={
            !isSmart && (
              <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setAdding(true)}>
                添加书签
              </Button>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {bookmarks.map((b) => (
            <li key={b.id}>
              <div className="group flex items-center gap-2.5 rounded-md border border-transparent px-2 py-2 transition-colors hover:border-line hover:bg-surface-hover">
                {b.faviconUrl ? (
                  <img src={b.faviconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm" loading="lazy" />
                ) : (
                  <span className="h-4 w-4 shrink-0 rounded-sm bg-sunken" aria-hidden />
                )}
                <a
                  href={b.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-ink hover:text-brand-ink hover:underline"
                  title={b.title || b.url}
                >
                  {b.title || b.url}
                </a>
                {!isSmart && (
                  <IconButton
                    label="从集合移除"
                    icon={<X size={14} />}
                    size="sm"
                    className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
                    onClick={() => remove.mutate({ collectionId: collection.id, bookmarkId: b.id })}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <CollectionFormDialog open={editing !== null} collection={editing} onClose={() => setEditing(null)} />

      <AddBookmarkDialog
        open={adding}
        collectionId={collection.id}
        existingIds={existingIds}
        onClose={() => setAdding(false)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            deleteCollection.mutate(deleting.id, {
              onSuccess: () => navigate('/collections'),
            });
          }
          setDeleting(null);
        }}
        title={`删除集合「${deleting?.name}」？`}
        message={
          deleting && deleting.count > 0
            ? `${deleting.count} 个书签会从集合中移除，但书签本身不会被删除。`
            : '这个集合还没有书签。'
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

/**
 * Picks an existing bookmark to add to the collection.
 *
 * Collections only reference bookmarks that already live in the library, so
 * there is no creation path here — search and select. Bookmarks already in the
 * collection are disabled so the list never offers a duplicate.
 */
function AddBookmarkDialog({
  open,
  collectionId,
  existingIds,
  onClose,
}: {
  open: boolean;
  collectionId: string;
  existingIds: Set<string>;
  onClose: () => void;
}) {
  const add = useAddToCollection();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Bookmark[]>([]);
  const [inGroup, setInGroup] = useState<Set<string>>(existingIds);
  const [loading, setLoading] = useState(false);
  // Monotonic request id so a slow response can never overwrite a newer one.
  const searchSeq = useRef(0);

  // Reset whenever the dialog opens.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    setQuery('');
    setResults([]);
    setInGroup(existingIds);
  }
  useEffect(() => {
    if (open) setInGroup(existingIds);
  }, [open, existingIds]);

  const runSearch = async (q: string) => {
    const seq = ++searchSeq.current;
    setLoading(true);
    try {
      const page = await api.get<{ items: Bookmark[] }>(
        `/bookmarks${qs({ scope: 'all', q: q.trim() || undefined, limit: 20, sort: 'created_desc' })}`,
      );
      if (seq !== searchSeq.current) return; // a newer search superseded this one
      setResults(page.items);
    } catch {
      if (seq !== searchSeq.current) return;
      setResults([]);
      toast.error('搜索失败', '请检查网络后重试');
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
  };

  const pick = (b: Bookmark) => {
    add.mutate(
      { collectionId, bookmarkId: b.id },
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
                        added ? 'cursor-default text-ink-faint' : 'hover:bg-surface-hover',
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

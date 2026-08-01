import { useEffect, useState } from 'react';
import { Archive, ExternalLink, Star } from 'lucide-react';
import { Button, Input, Modal, Skeleton, Switch, Textarea } from '@/components/ui';
import { TagPicker } from './TagPicker';
import { useOverlay } from '@/stores/ui';
import { useBookmark, useUpdateBookmark } from '@/hooks/queries';
import { displayHost, formatDate } from '@/lib/url';

export function BookmarkEditor({ id }: { id: string }) {
  const setEditingBookmarkId = useOverlay((s) => s.setEditingBookmarkId);
  const close = () => setEditingBookmarkId(null);

  const { data: bookmark, isLoading } = useBookmark(id);
  const update = useUpdateBookmark();

  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [isFavorite, setIsFavorite] = useState(false);
  const [isArchived, setIsArchived] = useState(false);

  // Hydrate once the record arrives; the dialog opens before the fetch lands.
  useEffect(() => {
    if (!bookmark) return;
    setTitle(bookmark.title);
    setUrl(bookmark.url);
    setNote(bookmark.note ?? '');
    setTagNames(bookmark.tags.map((t) => t.name));
    setIsFavorite(bookmark.isFavorite);
    setIsArchived(bookmark.isArchived);
  }, [bookmark]);

  const submit = () => {
    update.mutate(
      {
        id,
        patch: {
          title: title.trim(),
          url: url.trim(),
          note: note.trim() || null,
          tagNames,
          isFavorite,
          isArchived,
        },
      },
      { onSuccess: close },
    );
  };

  return (
    <Modal
      open
      onClose={close}
      title="编辑书签"
      description={bookmark ? displayHost(bookmark.url) : undefined}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={update.isPending} disabled={isLoading}>
            保存
          </Button>
        </>
      }
    >
      {isLoading || !bookmark ? (
        <div className="flex flex-col gap-3.5">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input label="标题" value={title} onChange={(e) => setTitle(e.target.value)} />

          <Input
            label="网址"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            inputMode="url"
            slotRight={
              <a
                href={bookmark.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="在新标签页打开"
                title="在新标签页打开"
                className="mr-0.5 flex h-7 w-7 items-center justify-center rounded-sm text-ink-faint hover:bg-surface-hover hover:text-ink"
              >
                <ExternalLink size={14} />
              </a>
            }
          />

          <TagPicker value={tagNames} onChange={setTagNames} />

          <Textarea
            label="笔记"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder="记下为什么保存这条，以后会用得上。"
          />

          <div className="flex flex-col gap-2.5 rounded-md border border-line px-3.5 py-3">
            <Switch
              checked={isFavorite}
              onChange={setIsFavorite}
              label="收藏"
              hint="出现在收藏列表中"
            />
            <div className="h-px bg-line" />
            <Switch
              checked={isArchived}
              onChange={setIsArchived}
              label="归档"
              hint="从主列表移除，但保留内容"
            />
          </div>

          {bookmark.aiSummary && (
            <div className="rounded-md bg-brand-soft px-3.5 py-3">
              <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-brand-ink">
                AI 摘要
              </p>
              <p className="text-xs leading-relaxed text-ink-soft">{bookmark.aiSummary}</p>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line pt-3 text-2xs text-ink-faint">
            <div className="flex justify-between">
              <dt>添加于</dt>
              <dd className="tabular-nums">{formatDate(bookmark.createdAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>更新于</dt>
              <dd className="tabular-nums">{formatDate(bookmark.updatedAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>访问次数</dt>
              <dd className="tabular-nums">{bookmark.visitCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt>状态</dt>
              <dd className="flex items-center gap-1">
                {isFavorite && <Star size={11} className="fill-caution text-caution" />}
                {isArchived && <Archive size={11} />}
                {!isFavorite && !isArchived && '普通'}
              </dd>
            </div>
          </dl>
        </form>
      )}
    </Modal>
  );
}

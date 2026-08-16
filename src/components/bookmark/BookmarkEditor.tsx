import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, ExternalLink, Lock, Star } from 'lucide-react';
import { Button, Input, Modal, Skeleton, Switch, Textarea } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { TagPicker } from './TagPicker';
import { SimilarBookmarks } from './SimilarBookmarks';
import { useOverlay } from '@/stores/ui';
import { useBookmark, useUpdateBookmark } from '@/hooks/queries';
import { useSetBookmarkPrivate } from '@/hooks/queries/vault';
import { useVault } from '@/stores/vault';
import { displayHost, formatDate } from '@/lib/url';

export function BookmarkEditor({ id }: { id: string }) {
  const setEditingBookmarkId = useOverlay((s) => s.setEditingBookmarkId);
  const close = () => setEditingBookmarkId(null);
  const navigate = useNavigate();

  const { data: bookmark, isLoading } = useBookmark(id);
  const update = useUpdateBookmark();
  const setPrivate = useSetBookmarkPrivate();

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

  /**
   * Moves this bookmark into the encrypted vault. The ciphertext is built from
   * the *saved* record, not the unsaved form state — encrypting a half-typed
   * edit would silently discard whatever the user had not committed yet.
   */
  const moveToVault = () => {
    if (!bookmark) return;
    if (!useVault.getState().getKey()) {
      toast.info('请先解锁私密保险库', '解锁后即可把书签加密移入私密空间。');
      close();
      navigate('/private');
      return;
    }
    setPrivate.mutate(bookmark, { onSuccess: close });
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
          {update.isError && (
            <div
              role="alert"
              className="rounded-md border border-critical/30 bg-critical-soft px-3.5 py-2.5 text-xs leading-relaxed text-critical"
            >
              保存失败：{update.error instanceof Error ? update.error.message : '请稍后重试'}
            </div>
          )}

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

          <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface/60 px-4 py-3.5">
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
            <div className="h-px bg-line" />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Lock size={13} aria-hidden />
                  私密书签
                </p>
                <p className="mt-0.5 text-2xs leading-relaxed text-ink-faint">
                  在本地加密后保存，并从全部列表、搜索、标签与分享中彻底隐藏。请先保存未提交的改动。
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={moveToVault}
                loading={setPrivate.isPending}
                className="shrink-0"
              >
                移入保险库
              </Button>
            </div>
          </div>

          {bookmark.aiSummary && (
            <div className="rounded-xl bg-brand-soft/70 px-4 py-3.5">
              <p className="atelier-eyebrow mb-1.5">AI 摘要</p>
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

          <SimilarBookmarks id={id} />
        </form>
      )}
    </Modal>
  );
}

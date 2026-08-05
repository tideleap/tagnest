import { useState } from 'react';
import { CheckSquare, RotateCcw, Tag as TagIcon, Trash2, X } from 'lucide-react';
import type { BookmarkScope } from '@shared/types';
import { Button, ConfirmDialog, IconButton, Input, Modal, TagChip } from '@/components/ui';
import { useSelection } from '@/stores/ui';
import {
  useBulkTag,
  useDeleteForever,
  useRestoreBookmarks,
  useTags,
  useTrashBookmarks,
} from '@/hooks/queries';

export function BulkActionBar({ scope, allIds }: { scope: BookmarkScope; allIds: string[] }) {
  const { selected, selectMany, clear } = useSelection();
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);

  const trash = useTrashBookmarks();
  const restore = useRestoreBookmarks();
  const purge = useDeleteForever();

  if (selected.size === 0) return null;

  const ids = [...selected];
  const inTrash = scope === 'trash';
  // True only when EVERY id on the current page is selected. Comparing counts
  // is wrong once the selection spans pages — after selecting page 1 fully and
  // part of page 2, `ids.length >= allIds.length` would already be true and flip
  // the button to "取消全选" even though page 2 has unselected rows.
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const run = (fn: () => void) => {
    fn();
    clear();
  };

  return (
    <>
      {/* Floats above the mobile tab bar rather than replacing it — the user
          should never lose their way out of a selection. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-16 z-30 flex justify-center px-3 md:bottom-5">
        <div className="anim-rise pointer-events-auto flex max-w-full items-center gap-1.5 overflow-x-auto rounded-lg border border-line bg-surface px-2.5 py-2 shadow-modal scrollbar-slim">
          <span className="shrink-0 px-1 text-xs font-medium tabular-nums text-ink">
            已选 {ids.length}
          </span>

          <span className="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden />

          <Button
            size="sm"
            variant="ghost"
            iconLeft={<CheckSquare size={14} />}
            onClick={() => (allSelected ? clear() : selectMany(allIds))}
          >
            {allSelected ? '取消全选' : '全选本页'}
          </Button>

          {inTrash ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<RotateCcw size={14} />}
                onClick={() => run(() => restore.mutate(ids))}
              >
                恢复
              </Button>
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<Trash2 size={14} />}
                onClick={() => setConfirmPurge(true)}
                className="text-critical-ink hover:bg-critical-soft"
              >
                永久删除
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<TagIcon size={14} />}
                onClick={() => setTagDialogOpen(true)}
              >
                打标签
              </Button>
              {/* Same verb and icon the card menu uses: this only soft-deletes,
                  and an Archive glyph labelled "删除" reads as either an archive
                  action or an irreversible purge — both wrong. */}
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<Trash2 size={14} />}
                onClick={() => run(() => trash.mutate(ids))}
              >
                移入回收站
              </Button>
            </>
          )}

          <IconButton
            label="取消选择"
            size="sm"
            icon={<X size={15} />}
            onClick={clear}
            className="ml-0.5 shrink-0"
          />
        </div>
      </div>

      <BulkTagDialog
        open={tagDialogOpen}
        onClose={() => setTagDialogOpen(false)}
        ids={ids}
        onDone={clear}
      />

      <ConfirmDialog
        open={confirmPurge}
        onClose={() => setConfirmPurge(false)}
        onConfirm={() => {
          purge.mutate(ids);
          setConfirmPurge(false);
          clear();
        }}
        title={`永久删除 ${ids.length} 项？`}
        message="这些书签将无法恢复。"
        confirmLabel="永久删除"
        tone="danger"
        loading={purge.isPending}
      />
    </>
  );
}

function BulkTagDialog({
  open,
  onClose,
  ids,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  ids: string[];
  onDone: () => void;
}) {
  const { data: tags } = useTags();
  const bulkTag = useBulkTag();
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const suggestions = (tags ?? [])
    .filter((t) => !picked.includes(t.name))
    .filter((t) => (draft ? t.name.toLowerCase().includes(draft.toLowerCase()) : true))
    .slice(0, 12);

  const addTag = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || picked.includes(trimmed)) return;
    setPicked((p) => [...p, trimmed]);
    setDraft('');
  };

  const submit = () => {
    if (picked.length === 0) return;
    bulkTag.mutate({ ids, addTagNames: picked });
    setPicked([]);
    onClose();
    onDone();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`为 ${ids.length} 个书签添加标签`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={picked.length === 0}
            loading={bulkTag.isPending}
          >
            添加
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag(draft);
            }
          }}
          placeholder="输入标签名，回车添加"
          label="标签"
          hint="不存在的标签会自动创建。"
        />

        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {picked.map((name) => (
              <li key={name}>
                <TagChip
                  name={name}
                  size="sm"
                  onRemove={() => setPicked((p) => p.filter((n) => n !== name))}
                />
              </li>
            ))}
          </ul>
        )}

        {suggestions.length > 0 && (
          <div>
            <p className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-ink-faint">
              已有标签
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {suggestions.map((t) => (
                <li key={t.id}>
                  <TagChip
                    name={t.name}
                    colorIndex={t.colorIndex}
                    count={t.count}
                    size="sm"
                    onClick={() => addTag(t.name)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

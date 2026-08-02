import { useEffect, useRef, useState } from 'react';
import { Sparkles, Wand2 } from 'lucide-react';
import { Button, Input, Modal, Textarea } from '@/components/ui';
import { TagPicker } from './TagPicker';
import { useOverlay } from '@/stores/ui';
import { useCreateBookmark, useFetchMetadata } from '@/hooks/queries';
import { normalizeUrl } from '@/lib/url';

/**
 * Paste a URL, hit save.
 *
 * Title and description are fetched in the background rather than blocking the
 * save button — a bookmark saved with a bare URL is far more useful than one
 * the user abandoned waiting for metadata.
 */
export function QuickAddDialog() {
  const setQuickAddOpen = useOverlay((s) => s.setQuickAddOpen);
  const create = useCreateBookmark();
  const fetchMeta = useFetchMetadata();

  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [urlError, setUrlError] = useState<string>();
  const [expanded, setExpanded] = useState(false);

  const urlRef = useRef<HTMLInputElement>(null);
  const lastFetchedRef = useRef<string | null>(null);

  // Offer whatever is on the clipboard if it looks like a link.
  useEffect(() => {
    void (async () => {
      try {
        const text = await navigator.clipboard.readText();
        const candidate = normalizeUrl(text);
        if (candidate && /^https?:\/\//.test(text.trim())) {
          setUrl(text.trim());
        }
      } catch {
        /* clipboard permission denied — no harm done */
      }
    })();
  }, []);

  const pullMetadata = (raw: string) => {
    const normalized = normalizeUrl(raw);
    if (!normalized || normalized === lastFetchedRef.current) return;
    lastFetchedRef.current = normalized;

    fetchMeta.mutate(normalized, {
      onSuccess: (meta) => {
        setTitle((current) => current || meta.title);
        setExpanded(true);
      },
    });
  };

  const submit = () => {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setUrlError('请输入有效的网址');
      urlRef.current?.focus();
      return;
    }

    create.mutate(
      {
        url: normalized,
        title: title.trim() || undefined,
        note: note.trim() || null,
        tagNames: tagNames.length > 0 ? tagNames : undefined,
      },
      { onSuccess: () => setQuickAddOpen(false) },
    );
  };

  return (
    <Modal
      open
      onClose={() => setQuickAddOpen(false)}
      title="添加书签"
      size="sm"
      initialFocusRef={urlRef}
      footer={
        <>
          <Button variant="ghost" onClick={() => setQuickAddOpen(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>
            保存
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          ref={urlRef}
          label="网址"
          required
          value={url}
          error={urlError}
          onChange={(e) => {
            setUrl(e.target.value);
            setUrlError(undefined);
          }}
          onBlur={(e) => pullMetadata(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              pullMetadata(url);
            }
          }}
          placeholder="https://example.com"
          inputMode="url"
          autoComplete="off"
          slotRight={
            <button
              type="button"
              onClick={() => pullMetadata(url)}
              disabled={!url.trim() || fetchMeta.isPending}
              aria-label="自动获取标题"
              title="自动获取标题"
              className="mr-0.5 flex h-7 w-7 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
            >
              <Wand2 size={14} className={fetchMeta.isPending ? 'anim-pulse' : undefined} />
            </button>
          }
        />

        {expanded ? (
          <>
            <Input
              label="标题"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={fetchMeta.isPending ? '正在获取…' : '留空则使用网页标题'}
            />
            <TagPicker value={tagNames} onChange={setTagNames} />
            <Textarea
              label="笔记"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="为什么要存这条？（可选）"
              rows={2}
            />
          </>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="self-start text-xs font-medium text-brand-ink underline-offset-2 hover:underline"
          >
            添加标题、标签和笔记
          </button>
        )}

        <p className="flex items-center gap-1.5 rounded-md bg-sunken px-2.5 py-2 text-2xs leading-relaxed text-ink-faint">
          <Sparkles size={13} className="shrink-0" aria-hidden />
          配置模型后，新书签保存时会自动生成摘要与标签建议；也可到「AI 整理」对整库批量整理。
        </p>
      </form>
    </Modal>
  );
}

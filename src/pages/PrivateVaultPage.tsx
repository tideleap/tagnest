import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Globe,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react';
import type { EncryptedBlob, VaultBookmarkData } from '@/lib/vault-crypto';
import { useVault } from '@/stores/vault';
import {
  usePrivateBookmarks,
  useCreatePrivateBookmark,
  useUpdatePrivateBookmark,
  useDeletePrivateBookmark,
  useUnsetBookmarkPrivate,
  encryptVaultFields,
  type DecryptedPrivateFields,
} from '@/hooks/queries/vault';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  Spinner,
  TagChip,
  Textarea,
  tagColorVars,
} from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { usePrivateTags, useSetTagPrivate } from '@/hooks/queries';
import { CategoryPrivateBookmarkEditor } from '@/components/vault/CategoryPrivateBookmarkEditor';
import { displayHost, relativeTime } from '@/lib/url';

function blankData(): VaultBookmarkData {
  return {
    url: '',
    title: '',
    description: null,
    note: null,
    faviconUrl: null,
    coverUrl: null,
    tagNames: [],
    isFavorite: false,
    isArchived: false,
  };
}

interface EditorState {
  mode: 'create' | 'edit';
  id?: string;
  initial: VaultBookmarkData;
}

/* ------------------------------------------------------------------ *
 * Encrypted bookmark editor (create / edit)
 * ------------------------------------------------------------------ */

function PrivateBookmarkEditor({
  state,
  onClose,
}: {
  state: EditorState;
  onClose: () => void;
}) {
  const [data, setData] = useState<VaultBookmarkData>(state.initial);
  const [tagsText, setTagsText] = useState((state.initial.tagNames ?? []).join(', '));
  const [busy, setBusy] = useState(false);

  const create = useCreatePrivateBookmark();
  const update = useUpdatePrivateBookmark();

  const set = <K extends keyof VaultBookmarkData>(key: K, value: VaultBookmarkData[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  const save = async () => {
    const url = data.url.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast.error('请填写有效链接', '以 http(s):// 开头');
      return;
    }
    const tagNames = tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 30);
    const payload: VaultBookmarkData = {
      ...data,
      url,
      title: data.title.trim(),
      description: data.description?.trim() || null,
      note: data.note?.trim() || null,
      tagNames,
    };

    setBusy(true);
    try {
      const blob: EncryptedBlob = await encryptVaultFields(payload);
      const blobStr = JSON.stringify(blob);
      if (state.mode === 'create') {
        await create.mutateAsync({ encryptedBlob: blobStr, isFavorite: payload.isFavorite, isArchived: payload.isArchived });
      } else if (state.id) {
        await update.mutateAsync({ id: state.id, encryptedBlob: blobStr });
      }
      onClose();
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : '加密或网络错误');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={state.mode === 'create' ? '新建私密书签' : '编辑私密书签'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="链接"
          value={data.url}
          onChange={(e) => set('url', e.target.value)}
          placeholder="https://example.com"
          autoFocus
        />
        <Input
          label="标题"
          value={data.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="可选，留空则显示域名"
        />
        <Textarea
          label="备注"
          value={data.note ?? ''}
          onChange={(e) => set('note', e.target.value || null)}
          rows={2}
          placeholder="仅自己可见的私密备注"
        />
        <Input
          label="标签（逗号分隔）"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="工作, 财务"
        />
        <div className="flex flex-wrap gap-5 pt-0.5">
          <Checkbox
            label="收藏"
            checked={Boolean(data.isFavorite)}
            onChange={(e) => set('isFavorite', e.target.checked)}
          />
          <Checkbox
            label="归档"
            checked={Boolean(data.isArchived)}
            onChange={(e) => set('isArchived', e.target.checked)}
          />
        </div>
        <p className="rounded-md bg-sunken px-3 py-2 text-2xs leading-relaxed text-ink-faint">
          内容会在你的浏览器内加密后上传，服务器只保存密文。
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-critical/25 bg-critical-soft p-4 sm:flex-row sm:items-center">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-critical shadow-raised">
        <AlertTriangle size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">加载失败</p>
        <p className="mt-0.5 break-words text-xs text-ink-soft">{message || '网络或服务器异常，请稍后重试。'}</p>
      </div>
      <Button variant="secondary" size="sm" iconLeft={<RefreshCw size={13} />} onClick={onRetry} className="shrink-0">
        重试
      </Button>
    </div>
  );
}

function Favicon({ src, alt }: { src?: string | null; alt?: string }) {
  return src ? (
    <img src={src} alt={alt ?? ''} className="h-4 w-4 shrink-0 rounded-sm" />
  ) : (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-sunken text-ink-faint">
      <Globe size={10} />
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Passphrase panels (setup / unlock)
 * ------------------------------------------------------------------ */

function PassphrasePanel({
  mode,
  passphrase,
  confirm,
  showPass,
  busy,
  error,
  onPassphrase,
  onConfirm,
  onToggleShow,
  onSubmit,
  onClearError,
}: {
  mode: 'setup' | 'unlock';
  passphrase: string;
  confirm: string;
  showPass: boolean;
  busy: boolean;
  error: string | null;
  onPassphrase: (v: string) => void;
  onConfirm: (v: string) => void;
  onToggleShow: () => void;
  onSubmit: () => void;
  onClearError: () => void;
}) {
  const isSetup = mode === 'setup';
  return (
    <div className="mx-auto mt-6 w-full max-w-md sm:mt-10">
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-float sm:p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
            {isSetup ? <ShieldCheck size={18} /> : <Lock size={18} />}
          </span>
          <div>
            <h2 className="text-base font-semibold text-ink">
              {isSetup ? '创建私密保险库' : '解锁私密保险库'}
            </h2>
            <p className="text-2xs text-ink-faint">
              {isSetup ? '密码仅保存在你的浏览器，无法找回' : '内容仅在本地解密显示'}
            </p>
          </div>
        </div>

        <Input
          label="密码"
          type={showPass ? 'text' : 'password'}
          value={passphrase}
          autoFocus
          placeholder={isSetup ? '至少 6 个字符' : '保险库密码'}
          error={error ?? undefined}
          onChange={(e) => {
            onClearError();
            onPassphrase(e.target.value);
          }}
          slotRight={
            <IconButton
              label={showPass ? '隐藏密码' : '显示密码'}
              size="sm"
              variant="ghost"
              pressed={showPass}
              icon={showPass ? <EyeOff size={14} /> : <Eye size={14} />}
              onClick={onToggleShow}
            />
          }
        />

        {isSetup && (
          <Input
            label="确认密码"
            type={showPass ? 'text' : 'password'}
            value={confirm}
            placeholder="再次输入密码"
            onChange={(e) => {
              onClearError();
              onConfirm(e.target.value);
            }}
          />
        )}

        <Button
          variant="primary"
          fullWidth
          size="lg"
          onClick={onSubmit}
          loading={busy}
          disabled={busy || passphrase.length === 0}
          iconLeft={isSetup ? <ShieldCheck size={16} /> : <LockOpen size={16} />}
        >
          {isSetup ? '创建保险库' : '解锁'}
        </Button>

        <p className="text-center text-2xs leading-relaxed text-ink-faint">
          {isSetup
            ? '书签会在浏览器内加密，服务器只保存密文，无法读取内容。'
            : '连续输错不会锁定账户，但错误密码无法解密任何内容。'}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Unlocked: encrypted vault list
 * ------------------------------------------------------------------ */

function UnlockedPanel({
  items,
  decrypted,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  onAdd,
  onEdit,
  onUnset,
  onRequestDelete,
}: {
  items: { id: string; isFavorite: boolean; isArchived: boolean; createdAt: string; updatedAt: string; encryptedBlob: string }[];
  decrypted: Record<string, VaultBookmarkData>;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string;
  onRetry: () => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onUnset: (id: string) => void;
  onRequestDelete: (id: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 py-2" aria-label="正在加载私密书签">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3.5">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="py-2">
        <ErrorCard message={errorMessage} onRetry={onRetry} />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title="私密保险库是空的"
        description={
          <>
            把不便公开的书签移到这里，它们会从所有列表和搜索中消失，只有你能解锁查看。
            被「类别私密」标签隐藏的书签则在下方专区管理。
          </>
        }
        action={
          <Button variant="primary" onClick={onAdd} iconLeft={<Plus size={15} />}>
            添加私密书签
          </Button>
        }
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2 py-2">
      {items.map((item) => {
        const d = decrypted[item.id];
        const failed = !d || (!d.url.trim() && !d.title.trim());
        const title = d?.title?.trim() || (d?.url ? displayHost(d.url) : '（无法解密）');
        const host = d?.url ? displayHost(d.url) : '';
        const tags = d?.tagNames ?? [];
        return (
          <li
            key={item.id}
            className="group flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-raised transition-all hover:border-line-strong hover:shadow-float sm:items-center"
          >
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sunken sm:mt-0">
              {d?.faviconUrl ? (
                <img src={d.faviconUrl} alt="" className="h-4.5 w-4.5 rounded-sm" />
              ) : (
                <Globe size={16} className="text-ink-faint" />
              )}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <button
                  type="button"
                  onClick={() => onEdit(item.id)}
                  className="min-w-0 truncate text-left text-sm font-medium text-ink transition-colors hover:text-brand-ink"
                >
                  {title}
                </button>
                {failed && <Badge tone="critical">无法解密</Badge>}
                {item.isFavorite && <Badge tone="caution">收藏</Badge>}
                {item.isArchived && <Badge tone="neutral">归档</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                {host && <span className="truncate text-2xs text-ink-faint">{host}</span>}
                {tags.slice(0, 3).map((t) => (
                  <TagChip key={t} name={t} size="sm" />
                ))}
                {tags.length > 3 && (
                  <span className="text-2xs text-ink-faint">+{tags.length - 3}</span>
                )}
              </div>
              <p className="mt-1 text-2xs text-ink-faint">更新于 {relativeTime(item.updatedAt)}</p>
            </div>

            <div className="flex shrink-0 items-center gap-0.5 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:focus-within:opacity-100">
              <IconButton
                label="编辑"
                size="sm"
                icon={<Pencil size={14} />}
                onClick={() => onEdit(item.id)}
              />
              <IconButton
                label="移出私密"
                size="sm"
                icon={<RotateCcw size={14} />}
                onClick={() => onUnset(item.id)}
              />
              <IconButton
                label="删除"
                size="sm"
                variant="danger"
                icon={<Trash2 size={14} />}
                onClick={() => onRequestDelete(item.id)}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * Unlocked: category-private section
 * ------------------------------------------------------------------ */

function CategoryPrivateSection() {
  const [rawQ, setRawQ] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQ(rawQ.trim()), 250);
    return () => clearTimeout(t);
  }, [rawQ]);

  const { data, isLoading, isError, error, refetch } = usePrivateTags(q);
  const setPrivate = useSetTagPrivate();
  const [unsetId, setUnsetId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const entries = data?.tags ?? [];
  const totalCount = entries.reduce((n, e) => n + e.bookmarks.length, 0);
  const searching = q.trim().length > 0;

  return (
    <section className="mt-6 border-t border-line pt-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-soft text-brand-ink">
          <Lock size={13} aria-hidden />
        </span>
        <h2 className="text-sm font-semibold text-ink">类别私密</h2>
        <Badge tone="neutral">仅对其他人隐藏 · 未加密</Badge>
        {entries.length > 0 && (
          <span className="text-2xs tabular-nums text-ink-faint">
            {entries.length} 个类别 · {totalCount} 个书签
          </span>
        )}
      </div>
      <p className="mb-3 text-2xs leading-relaxed text-ink-faint">
        将某个标签设为私密后，它及其所有子标签下的书签会对其他用户完全隐藏，只有你能在此查看、检索与管理。
      </p>

      <div className="mb-3">
        <Input
          value={rawQ}
          onChange={(e) => setRawQ(e.target.value)}
          placeholder="搜索被隐藏的书签…"
          iconLeft={<Search size={14} />}
          aria-label="搜索被隐藏的书签"
        />
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-3.5">
              <Skeleton className="h-4 w-1/3" />
              <div className="mt-3 space-y-2">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <ErrorCard message={error instanceof Error ? error.message : ''} onRetry={() => void refetch()} />
      ) : entries.length === 0 ? (
        searching ? (
          <EmptyState
            compact
            icon={<Search size={20} />}
            title="未找到匹配的书签"
            description={`没有与「${q.trim()}」匹配的类别私密书签。`}
          />
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-line-strong bg-sunken/50 px-4 py-3.5">
            <Lock size={15} className="shrink-0 text-ink-faint" aria-hidden />
            <p className="text-2xs leading-relaxed text-ink-faint">
              当前没有类别私密标签。在标签页把某个标签设为私密后，它隐藏的书签会出现在这里。
            </p>
          </div>
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map(({ tag, bookmarks }) => (
            <li key={tag.id} className="rounded-xl border border-line bg-surface p-3.5 shadow-raised">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  style={tagColorVars(tag.colorIndex)}
                  className="h-4 w-4 shrink-0 rounded bg-[var(--tag-bg)] ring-1 ring-inset ring-[var(--tag-dot)]"
                  aria-hidden
                />
                <span className="text-sm font-medium text-ink">{tag.name}</span>
                <Badge tone="brand">{bookmarks.length} 个书签被隐藏</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  iconLeft={<LockOpen size={13} />}
                  onClick={() => setUnsetId(tag.id)}
                >
                  取消私密
                </Button>
              </div>

              {bookmarks.length > 0 && (
                <ul className="mt-2.5 flex flex-col gap-0.5 border-t border-line pt-2">
                  {bookmarks.slice(0, 20).map((b) => (
                    <li key={b.id}>
                      <button
                        type="button"
                        onClick={() => setEditingId(b.id)}
                        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink"
                      >
                        <Favicon src={b.faviconUrl} />
                        <span className="truncate">{b.title?.trim() || displayHost(b.url)}</span>
                        {b.isFavorite && (
                          <Star size={11} className="shrink-0 fill-caution text-caution" />
                        )}
                      </button>
                    </li>
                  ))}
                  {bookmarks.length > 20 && (
                    <li className="px-2 py-1 text-2xs text-ink-faint">
                      …还有 {bookmarks.length - 20} 个
                    </li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {editingId && (
        <CategoryPrivateBookmarkEditor
          id={editingId}
          onClose={() => setEditingId(null)}
          onDeleted={() => {
            // Query invalidation happens inside the mutation; the modal closes
            // via onDeleted + onClose.
          }}
        />
      )}

      <ConfirmDialog
        open={unsetId !== null}
        onClose={() => setUnsetId(null)}
        onConfirm={() => {
          if (unsetId) setPrivate.mutate({ id: unsetId, isPrivate: false });
          setUnsetId(null);
        }}
        title="取消该类别的私密？"
        message="取消后，该标签及其所有子标签下的书签会重新对所有人可见。"
        confirmLabel="取消私密"
        loading={setPrivate.isPending}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export function PrivateVaultPage() {
  const status = useVault((s) => s.status);
  const error = useVault((s) => s.error);
  const bootstrap = useVault((s) => s.bootstrap);
  const setup = useVault((s) => s.setup);
  const unlock = useVault((s) => s.unlock);
  const lock = useVault((s) => s.lock);
  const decryptBlob = useVault((s) => s.decryptBlob);
  const clearError = useVault((s) => s.clearError);

  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, isLoading, isError, error: listError, refetch } = usePrivateBookmarks();
  const unsetBm = useUnsetBookmarkPrivate();
  const deleteBm = useDeletePrivateBookmark();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [decrypted, setDecrypted] = useState<Record<string, VaultBookmarkData>>({});
  const [purgeId, setPurgeId] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Decrypt every ciphertext row once the vault is unlocked and the list loads.
  useEffect(() => {
    let cancelled = false;
    if (status !== 'unlocked' || !data) {
      setDecrypted({});
      return;
    }
    (async () => {
      const out: Record<string, VaultBookmarkData> = {};
      for (const item of data.items) {
        try {
          out[item.id] = await decryptBlob(JSON.parse(item.encryptedBlob) as EncryptedBlob);
        } catch {
          out[item.id] = blankData();
        }
      }
      if (!cancelled) setDecrypted(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, data, decryptBlob]);

  const doSetup = async () => {
    if (passphrase.length < 6) {
      toast.error('密码太短', '请至少使用 6 个字符');
      return;
    }
    if (passphrase !== confirm) {
      toast.error('两次输入不一致');
      return;
    }
    setBusy(true);
    try {
      await setup(passphrase);
      setPassphrase('');
      setConfirm('');
      toast.success('私密保险库已创建');
    } catch (e) {
      toast.error('创建失败', e instanceof Error ? e.message : '请重试');
    } finally {
      setBusy(false);
    }
  };

  const doUnlock = async () => {
    setBusy(true);
    try {
      const ok = await unlock(passphrase);
      if (ok) setPassphrase('');
    } finally {
      setBusy(false);
    }
  };

  const doUnset = (id: string) => {
    const d = decrypted[id];
    if (!d) return;
    const fields: DecryptedPrivateFields = {
      url: d.url,
      title: d.title,
      description: d.description,
      note: d.note,
      faviconUrl: d.faviconUrl,
      coverUrl: d.coverUrl,
      tagNames: d.tagNames,
    };
    unsetBm.mutate({ id, fields });
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="私密空间"
        icon={<Lock size={13} />}
        title="私密保险库"
        description={
          status === 'unlocked'
            ? '已解锁，内容仅本地解密显示'
            : status === 'locked'
              ? '输入密码以解锁'
              : '为不便公开的书签设置一个独立密码'
        }
      >
        {status === 'unlocked' && (
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Lock size={14} />}
            onClick={() => lock()}
          >
            锁定
          </Button>
        )}
        {status === 'unlocked' && (
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Plus size={14} />}
            onClick={() => setEditor({ mode: 'create', initial: blankData() })}
          >
            添加
          </Button>
        )}
      </PageHeader>

      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-1 pb-6">
        {status === 'unknown' ? (
          <div className="flex h-40 flex-col items-center justify-center gap-3 text-sm text-ink-faint">
            <Spinner size={20} label="正在检查保险库状态" />
            正在检查保险库状态…
          </div>
        ) : status === 'unconfigured' ? (
          <PassphrasePanel
            mode="setup"
            passphrase={passphrase}
            confirm={confirm}
            showPass={showPass}
            busy={busy}
            error={error}
            onPassphrase={setPassphrase}
            onConfirm={setConfirm}
            onToggleShow={() => setShowPass((v) => !v)}
            onSubmit={() => void doSetup()}
            onClearError={clearError}
          />
        ) : status === 'locked' ? (
          <PassphrasePanel
            mode="unlock"
            passphrase={passphrase}
            confirm={confirm}
            showPass={showPass}
            busy={busy}
            error={error}
            onPassphrase={setPassphrase}
            onConfirm={setConfirm}
            onToggleShow={() => setShowPass((v) => !v)}
            onSubmit={() => void doUnlock()}
            onClearError={clearError}
          />
        ) : (
          <UnlockedPanel
            items={data?.items ?? []}
            decrypted={decrypted}
            isLoading={isLoading}
            isError={isError}
            errorMessage={listError instanceof Error ? listError.message : ''}
            onRetry={() => void refetch()}
            onAdd={() => setEditor({ mode: 'create', initial: blankData() })}
            onEdit={(id) => {
              const d = decrypted[id];
              if (d) setEditor({ mode: 'edit', id, initial: d });
            }}
            onUnset={doUnset}
            onRequestDelete={setPurgeId}
          />
        )}

        {/* Category-private rows are server-side PLAINTEXT (hidden from other
            users, not encrypted). They must never render — nor be fetched —
            while the vault is locked; the unlock gate above is the only door. */}
        {status === 'unlocked' && <CategoryPrivateSection />}
      </div>

      {editor && <PrivateBookmarkEditor state={editor} onClose={() => setEditor(null)} />}

      <ConfirmDialog
        open={purgeId !== null}
        onClose={() => setPurgeId(null)}
        onConfirm={() => {
          if (purgeId) deleteBm.mutate(purgeId);
          setPurgeId(null);
        }}
        title="从私密保险库删除？"
        message="此操作会永久删除这条加密书签，无法恢复。"
        confirmLabel="删除"
        tone="danger"
        loading={deleteBm.isPending}
      />
    </div>
  );
}

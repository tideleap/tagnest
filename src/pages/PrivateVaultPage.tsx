import { useEffect, useState } from 'react';
import { Lock, LockOpen, Plus, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
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
import { Button, IconButton, Modal, PageHeader, ConfirmDialog, EmptyState } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
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
      <div className="flex flex-col gap-3.5">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-soft">
          链接
          <input
            value={data.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://example.com"
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-soft">
          标题
          <input
            value={data.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="可选，留空则显示域名"
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-soft">
          备注
          <textarea
            value={data.note ?? ''}
            onChange={(e) => set('note', e.target.value || null)}
            rows={2}
            placeholder="仅自己可见的私密备注"
            className="resize-none rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-soft">
          标签（逗号分隔）
          <input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="工作, 财务"
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <div className="flex gap-5 pt-1">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={Boolean(data.isFavorite)}
              onChange={(e) => set('isFavorite', e.target.checked)}
              className="h-4 w-4 rounded border-line-strong accent-[var(--color-brand)]"
            />
            收藏
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={Boolean(data.isArchived)}
              onChange={(e) => set('isArchived', e.target.checked)}
              className="h-4 w-4 rounded border-line-strong accent-[var(--color-brand)]"
            />
            归档
          </label>
        </div>
      </div>
    </Modal>
  );
}

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

  const { data, isLoading } = usePrivateBookmarks();
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

  const HeaderIcon = status === 'locked' ? Lock : LockOpen;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<HeaderIcon size={20} />}
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
            iconLeft={<Lock size={15} />}
            onClick={() => lock()}
          >
            锁定
          </Button>
        )}
        {status === 'unlocked' && (
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Plus size={15} />}
            onClick={() =>
              setEditor({ mode: 'create', initial: blankData() })
            }
          >
            添加
          </Button>
        )}
      </PageHeader>

      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-1">
        {status === 'unknown' ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-faint">
            正在检查保险库状态…
          </div>
        ) : status === 'unconfigured' ? (
          <SetupPanel
            passphrase={passphrase}
            confirm={confirm}
            showPass={showPass}
            busy={busy}
            error={error}
            onPassphrase={setPassphrase}
            onConfirm={setConfirm}
            onToggleShow={() => setShowPass((v) => !v)}
            onSetup={() => void doSetup()}
            onClearError={clearError}
          />
        ) : status === 'locked' ? (
          <UnlockPanel
            passphrase={passphrase}
            showPass={showPass}
            busy={busy}
            error={error}
            onPassphrase={setPassphrase}
            onToggleShow={() => setShowPass((v) => !v)}
            onUnlock={() => void doUnlock()}
            onClearError={clearError}
          />
        ) : (
          <UnlockedPanel
            items={data?.items ?? []}
            decrypted={decrypted}
            isLoading={isLoading}
            onAdd={() => setEditor({ mode: 'create', initial: blankData() })}
            onEdit={(id) => {
              const d = decrypted[id];
              if (d) setEditor({ mode: 'edit', id, initial: d });
            }}
            onUnset={doUnset}
            onRequestDelete={setPurgeId}
          />
        )}
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

function Field({
  label,
  value,
  type = 'text',
  placeholder,
  autoFocus,
  onChange,
}: {
  label: string;
  value: string;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-soft">
      {label}
      <input
        type={type}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
      />
    </label>
  );
}

function SetupPanel({
  passphrase,
  confirm,
  showPass,
  busy,
  error,
  onPassphrase,
  onConfirm,
  onToggleShow,
  onSetup,
  onClearError,
}: {
  passphrase: string;
  confirm: string;
  showPass: boolean;
  busy: boolean;
  error: string | null;
  onPassphrase: (v: string) => void;
  onConfirm: (v: string) => void;
  onToggleShow: () => void;
  onSetup: () => void;
  onClearError: () => void;
}) {
  return (
    <div className="mx-auto mt-6 max-w-md">
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-float">
        <div className="flex items-center gap-2.5 text-brand-ink">
          <ShieldCheck size={20} />
          <h2 className="text-base font-semibold">创建私密保险库</h2>
        </div>
        <p className="text-xs leading-relaxed text-ink-soft">
          设置一个独立密码。书签会在你的浏览器内加密，服务器只保存密文，无法读取内容。
          密码不会被服务器存储，<span className="font-medium text-ink">也无法找回</span>。
        </p>

        <Field
          label="密码"
          type={showPass ? 'text' : 'password'}
          value={passphrase}
          placeholder="至少 6 个字符"
          autoFocus
          onChange={(v) => {
            onClearError();
            onPassphrase(v);
          }}
        />
        <Field
          label="确认密码"
          type={showPass ? 'text' : 'password'}
          value={confirm}
          onChange={(v) => {
            onClearError();
            onConfirm(v);
          }}
        />

        <button
          type="button"
          onClick={onToggleShow}
          className="self-start text-2xs text-ink-faint hover:text-ink-soft"
        >
          {showPass ? '隐藏密码' : '显示密码'}
        </button>

        {error && <p className="text-xs text-critical-ink">{error}</p>}

        <Button variant="primary" onClick={onSetup} loading={busy} disabled={busy}>
          创建保险库
        </Button>
      </div>
    </div>
  );
}

function UnlockPanel({
  passphrase,
  showPass,
  busy,
  error,
  onPassphrase,
  onToggleShow,
  onUnlock,
  onClearError,
}: {
  passphrase: string;
  showPass: boolean;
  busy: boolean;
  error: string | null;
  onPassphrase: (v: string) => void;
  onToggleShow: () => void;
  onUnlock: () => void;
  onClearError: () => void;
}) {
  return (
    <div className="mx-auto mt-10 max-w-sm">
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-float">
        <div className="flex items-center gap-2.5 text-brand-ink">
          <Lock size={20} />
          <h2 className="text-base font-semibold">解锁私密保险库</h2>
        </div>
        <p className="text-xs leading-relaxed text-ink-soft">
          输入密码以在本地解密并查看你的私密书签。
        </p>

        <Field
          label="密码"
          type={showPass ? 'text' : 'password'}
          value={passphrase}
          autoFocus
          placeholder="保险库密码"
          onChange={(v) => {
            onClearError();
            onPassphrase(v);
          }}
        />

        <button
          type="button"
          onClick={onToggleShow}
          className="self-start text-2xs text-ink-faint hover:text-ink-soft"
        >
          {showPass ? '隐藏密码' : '显示密码'}
        </button>

        {error && <p className="text-xs text-critical-ink">{error}</p>}

        <Button
          variant="primary"
          onClick={onUnlock}
          loading={busy}
          disabled={busy || passphrase.length === 0}
        >
          解锁
        </Button>
      </div>
    </div>
  );
}

function UnlockedPanel({
  items,
  decrypted,
  isLoading,
  onAdd,
  onEdit,
  onUnset,
  onRequestDelete,
}: {
  items: { id: string; isFavorite: boolean; isArchived: boolean; createdAt: string; updatedAt: string; encryptedBlob: string }[];
  decrypted: Record<string, VaultBookmarkData>;
  isLoading: boolean;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onUnset: (id: string) => void;
  onRequestDelete: (id: string) => void;
}) {
  if (isLoading) {
    return <div className="flex h-40 items-center justify-center text-sm text-ink-faint">加载中…</div>;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title="私密保险库是空的"
        description="把不便公开的书签移到这里，它们会从所有列表和搜索中消失，只有你能解锁查看。"
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
        const title = d?.title || (d ? displayHost(d.url) : '（无法解密）');
        const host = d?.url ? displayHost(d.url) : '';
        return (
          <li
            key={item.id}
            className="group flex items-center gap-3 rounded-lg border border-line bg-surface p-3 transition-colors hover:border-line-strong"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onEdit(item.id)}
                  className="min-w-0 truncate text-left text-sm font-medium text-ink hover:text-brand-ink"
                >
                  {title}
                </button>
                {item.isFavorite && (
                  <span className="shrink-0 rounded-full bg-caution-soft px-1.5 py-0.5 text-2xs text-caution-ink">
                    收藏
                  </span>
                )}
                {item.isArchived && (
                  <span className="shrink-0 rounded-full bg-sunken px-1.5 py-0.5 text-2xs text-ink-faint">
                    归档
                  </span>
                )}
              </div>
              {host && <p className="truncate text-2xs text-ink-faint">{host}</p>}
              {d?.tagNames?.length > 0 && (
                <p className="mt-0.5 truncate text-2xs text-ink-faint">
                  #{d.tagNames.join(' #')}
                </p>
              )}
              <p className="mt-0.5 text-2xs text-ink-faint">
                更新于 {relativeTime(item.updatedAt)}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <IconButton
                label="移出私密"
                size="sm"
                icon={<RotateCcw size={15} />}
                onClick={() => onUnset(item.id)}
              />
              <IconButton
                label="删除"
                size="sm"
                icon={<Trash2 size={15} />}
                onClick={() => onRequestDelete(item.id)}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

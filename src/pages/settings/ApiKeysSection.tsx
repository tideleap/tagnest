import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { ApiKeyCreated, ApiKeyInput, ApiKeyScope } from '@shared/types';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Input,
  Modal,
  Select,
  Skeleton,
  toast,
} from '@/components/ui';
import {
  useApiKeys,
  useCreateApiKey,
  useDeleteApiKey,
} from '@/hooks/queries';
import { relativeTime } from '@/lib/url';
import { Card } from './Card';

/* ------------------------------------------------------------------ *
 * Personal access keys (O5)
 * ------------------------------------------------------------------ */

const SCOPE_OPTIONS: { value: ApiKeyScope; label: string; hint: string }[] = [
  { value: 'read', label: '读取', hint: '查看书签、标签与统计' },
  { value: 'write', label: '写入', hint: '新增、修改、删除书签' },
];

const KEY_EXPIRY_OPTIONS = [
  { value: '0', label: '永不过期' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '1 年' },
];

export function ApiKeysSection() {
  const { data: keys, isLoading } = useApiKeys();
  const create = useCreateApiKey();
  const del = useDeleteApiKey();

  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['read', 'write']);
  const [expiresInDays, setExpiresInDays] = useState(0);

  const toggleScope = (scope: ApiKeyScope) =>
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );

  const submitCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const input: ApiKeyInput = { name: trimmed, scopes, expiresInDays };
    create.mutate(input, {
      onSuccess: (res) => {
        setCreated(res);
        setShowCreate(false);
        setName('');
        setScopes(['read', 'write']);
        setExpiresInDays(0);
      },
    });
  };

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      toast.success('密钥已复制');
    } catch {
      toast.error('复制失败', '浏览器拒绝了剪贴板访问');
    }
  };

  return (
    <>
      <Card
        title="个人访问密钥"
        description="用密钥代替账号访问你的书签，方便脚本或第三方工具调用。密钥无法访问登录、注册与密钥管理接口。"
      >
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : keys && keys.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {keys.map((k) => (
              <li
                key={k.id}
                className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{k.name}</span>
                    <code className="rounded bg-sunken px-1.5 py-0.5 text-2xs text-ink-soft">
                      {k.prefix}…
                    </code>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-ink-faint">
                    {k.scopes.map((s) => (
                      <Badge key={s} tone="brand">
                        {s}
                      </Badge>
                    ))}
                    <span>创建于 {relativeTime(k.createdAt)}</span>
                    {k.lastUsedAt && <span>· 最近使用 {relativeTime(k.lastUsedAt)}</span>}
                    {k.expiresAt && <span>· {relativeTime(k.expiresAt)}过期</span>}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteId(k.id)}
                  className="shrink-0 text-critical hover:bg-critical-soft"
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            compact
            icon={<KeyRound size={20} />}
            title="还没有密钥"
            description="创建一个密钥，用它从命令行或脚本访问你的书签库。"
          />
        )}

        <div className="mt-3">
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            新建密钥
          </Button>
        </div>
      </Card>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="新建密钥"
        description="密钥只显示这一次，关闭后无法再次查看。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={submitCreate}
              loading={create.isPending}
              disabled={!name.trim()}
            >
              创建
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Input
            label="名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：终端脚本"
            required
            autoFocus
          />
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-ink-soft">权限范围</span>
            {SCOPE_OPTIONS.map((opt) => (
              <Checkbox
                key={opt.value}
                label={opt.label}
                hint={opt.hint}
                checked={scopes.includes(opt.value)}
                onChange={() => toggleScope(opt.value)}
              />
            ))}
          </div>
          <Select
            label="有效期"
            value={String(expiresInDays)}
            onChange={(e) => setExpiresInDays(Number(e.target.value))}
            options={KEY_EXPIRY_OPTIONS}
          />
        </div>
      </Modal>

      <Modal
        open={created !== null}
        onClose={() => setCreated(null)}
        title="密钥已创建"
        description="这是唯一一次看到完整密钥的机会，请立即复制保存。"
      >
        {created && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={created.token}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full truncate rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs text-ink"
                aria-label="密钥令牌"
              />
              <Button variant="primary" size="sm" onClick={() => copyToken(created.token)}>
                复制
              </Button>
            </div>
            <p className="text-xs text-ink-faint">
              名称：{created.key.name} · 权限：{created.key.scopes.join('、')}
            </p>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (deleteId) del.mutate(deleteId);
          setDeleteId(null);
        }}
        title="删除密钥"
        message="删除后，使用该密钥的脚本会立即失效。此操作无法撤销。"
        confirmLabel="删除"
        tone="danger"
        loading={del.isPending}
      />
    </>
  );
}

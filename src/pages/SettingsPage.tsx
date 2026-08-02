import { useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import {
  Copy,
  ExternalLink,
  Info,
  KeyRound,
  Keyboard,
  Pencil,
  Palette,
  Share2,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react';
import type {
  AiProvider,
  ApiKeyCreated,
  ApiKeyInput,
  ApiKeyScope,
  Share,
  ShareInput,
  ShareTheme,
} from '@shared/types';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Kbd,
  Modal,
  Select,
  Skeleton,
  Switch,
  TagChip,
  Textarea,
  toast,
} from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { useTheme, THEMES } from '@/stores/ui';
import {
  useAiSettings,
  useApiKeys,
  useCreateApiKey,
  useCreateShare,
  useDeleteApiKey,
  useDeleteShare,
  useShares,
  useStats,
  useTags,
  useUpdateAiSettings,
  useUpdateShare,
} from '@/hooks/queries';
import { SHORTCUTS } from '@/hooks/useGlobalHotkeys';
import { relativeTime } from '@/lib/url';
import { cx } from '@/lib/cx';

const SECTIONS = [
  { id: 'account', label: '账户', icon: User },
  { id: 'keys', label: '密钥', icon: KeyRound },
  { id: 'shares', label: '分享', icon: Share2 },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'ai', label: 'AI 助手', icon: Sparkles },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'about', label: '关于', icon: Info },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function SettingsPage() {
  const { section } = useParams();
  const active: SectionId = SECTIONS.some((s) => s.id === section)
    ? (section as SectionId)
    : 'account';

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 lg:flex-row lg:gap-8">
      <nav aria-label="设置分区" className="shrink-0 lg:w-44">
        <h1 className="mb-3 text-lg font-semibold text-ink">设置</h1>
        <ul className="flex gap-1 overflow-x-auto scrollbar-slim lg:flex-col">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <li key={id} className="shrink-0">
              <NavLink
                to={`/settings/${id}`}
                className={cx(
                  'flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
                  active === id
                    ? 'bg-brand-soft text-brand-ink'
                    : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
                )}
              >
                <Icon size={16} aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 flex-1">
        {active === 'account' && <AccountSection />}
        {active === 'keys' && <ApiKeysSection />}
        {active === 'shares' && <SharesSection />}
        {active === 'appearance' && <AppearanceSection />}
        {active === 'ai' && <AiSection />}
        {active === 'shortcuts' && <ShortcutsSection />}
        {active === 'about' && <AboutSection />}
      </div>
    </div>
  );
}

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 rounded-md border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description && <p className="mt-1 text-xs leading-relaxed text-ink-soft">{description}</p>}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

function AccountSection() {
  const user = useAuth((s) => s.user);
  const { data: stats, isLoading } = useStats();

  return (
    <>
      <Card title="账户信息">
        <dl className="flex flex-col gap-2.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">显示名称</dt>
            <dd className="truncate font-medium text-ink">{user?.displayName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">邮箱</dt>
            <dd className="truncate font-medium text-ink">{user?.email}</dd>
          </div>
        </dl>
      </Card>

      <Card title="数据概览">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: '书签', value: stats?.bookmarks ?? 0 },
              { label: '标签', value: stats?.tags ?? 0 },
              { label: '收藏', value: stats?.favorites ?? 0 },
              { label: '近 7 天新增', value: stats?.addedLast7Days ?? 0 },
            ].map((item) => (
              <div key={item.label} className="rounded-md bg-sunken px-3 py-2.5">
                <dt className="text-2xs text-ink-faint">{item.label}</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{item.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </>
  );
}

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

function ApiKeysSection() {
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

/* ------------------------------------------------------------------ *
 * Public shares (O7)
 * ------------------------------------------------------------------ */

const SHARE_THEME_OPTIONS: { value: ShareTheme; label: string }[] = [
  { value: 'default', label: '默认列表' },
  { value: 'compact', label: '紧凑列表' },
  { value: 'cards', label: '卡片网格' },
];

const SHARE_EXPIRY_OPTIONS = [
  { value: '0', label: '永不过期' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
];

const SHARE_THEME_LABEL: Record<ShareTheme, string> = {
  default: '默认',
  compact: '紧凑',
  cards: '卡片',
};

function SharesSection() {
  const { data: shares, isLoading } = useShares();
  const { data: tags } = useTags();
  const create = useCreateShare();
  const update = useUpdateShare();
  const del = useDeleteShare();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Share | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [matchAllTags, setMatchAllTags] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [theme, setTheme] = useState<ShareTheme>('default');
  const [isActive, setIsActive] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState(0);

  const openCreate = () => {
    setEditing(null);
    setTitle('');
    setSlug('');
    setDescription('');
    setTagIds([]);
    setMatchAllTags(false);
    setIncludeNotes(true);
    setTheme('default');
    setIsActive(true);
    setExpiresInDays(0);
    setShowForm(true);
  };

  const openEdit = (s: Share) => {
    setEditing(s);
    setTitle(s.title);
    setSlug(s.slug);
    setDescription(s.description ?? '');
    setTagIds(s.tagIds);
    setMatchAllTags(s.matchAllTags);
    setIncludeNotes(s.includeNotes);
    setTheme(s.theme);
    setIsActive(s.isActive);
    setExpiresInDays(0);
    setShowForm(true);
  };

  const toggleTag = (id: string) =>
    setTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submitting = create.isPending || update.isPending;

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const input: ShareInput = {
      title: trimmed,
      slug: slug.trim() || undefined,
      description: description.trim() || null,
      tagIds,
      matchAllTags,
      includeNotes,
      theme,
      isActive,
      expiresInDays,
    };
    if (editing) {
      update.mutate(
        { id: editing.id, patch: input },
        { onSuccess: () => setShowForm(false) },
      );
    } else {
      create.mutate(input, { onSuccess: () => setShowForm(false) });
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${url}`);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败', '浏览器拒绝了剪贴板访问');
    }
  };

  return (
    <>
      <Card
        title="公开分享"
        description="把指定标签下的书签整理成一个只读页面，任何人都能通过链接访问。分享的是实时查询结果，不是快照。"
      >
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : shares && shares.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {shares.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-ink">{s.title}</span>
                    <Badge tone={s.isActive ? 'positive' : 'neutral'}>
                      {s.isActive ? '已启用' : '已停用'}
                    </Badge>
                    <Badge>{SHARE_THEME_LABEL[s.theme]}</Badge>
                    {s.tagIds.length > 0 && (
                      <span className="text-2xs text-ink-faint">
                        {s.tagIds.length} 个标签筛选
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-ink-faint">
                    <code className="rounded bg-sunken px-1.5 py-0.5">{s.url}</code>
                    <span>· {s.viewCount} 次浏览</span>
                    <span>· 创建于 {relativeTime(s.createdAt)}</span>
                    {s.expiresAt && <span>· {relativeTime(s.expiresAt)}过期</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton label="复制链接" size="sm" onClick={() => copyLink(s.url)} icon={<Copy size={15} />} />
                  <IconButton
                    label="打开"
                    size="sm"
                    onClick={() => window.open(s.url, '_blank', 'noopener,noreferrer')}
                    icon={<ExternalLink size={15} />}
                  />
                  <IconButton label="编辑" size="sm" onClick={() => openEdit(s)} icon={<Pencil size={15} />} />
                  <IconButton
                    label="删除"
                    size="sm"
                    onClick={() => setDeleteId(s.id)}
                    icon={<Trash2 size={15} />}
                    className="text-critical hover:bg-critical-soft"
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            compact
            icon={<Share2 size={20} />}
            title="还没有分享页"
            description="挑一些标签，生成一个可以发给任何人的只读书签页。"
          />
        )}

        <div className="mt-3">
          <Button variant="primary" onClick={openCreate}>
            新建分享
          </Button>
        </div>
      </Card>

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing ? '编辑分享' : '新建分享'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowForm(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={submit} loading={submitting} disabled={!title.trim()}>
              {editing ? '保存' : '创建'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Input
            label="标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：每周阅读清单"
            required
            autoFocus
          />
          <Input
            label="自定义路径"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="留空则根据标题自动生成"
            hint="链接会显示为 /s/你的路径"
          />
          <Textarea
            label="描述"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一句话介绍这个分享页（可留空）"
            rows={2}
          />

          {tags && tags.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-ink-soft">
                包含标签（不选则分享全部书签）
              </span>
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto scrollbar-slim">
                {tags.map((t) => {
                  const active = tagIds.includes(t.id);
                  return (
                    <TagChip
                      key={t.id}
                      name={t.name}
                      colorIndex={t.colorIndex}
                      active={active}
                      onClick={() => toggleTag(t.id)}
                    />
                  );
                })}
              </div>
              {tagIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setTagIds([])}
                  className="self-start text-2xs text-ink-faint underline-offset-2 hover:text-ink-soft hover:underline"
                >
                  清除筛选
                </button>
              )}
            </div>
          )}

          <Switch
            checked={matchAllTags}
            onChange={setMatchAllTags}
            label="需同时满足所有标签"
            hint="开启后，只有带全部所选标签的书签才会出现"
          />
          <Switch
            checked={includeNotes}
            onChange={setIncludeNotes}
            label="展示笔记内容"
            hint="关闭则分享页只显示标题、链接与标签"
          />
          <Switch
            checked={isActive}
            onChange={setIsActive}
            label="立即启用"
            hint="关闭后链接将暂时返回 404"
          />
          <Select
            label="主题"
            value={theme}
            onChange={(e) => setTheme(e.target.value as ShareTheme)}
            options={SHARE_THEME_OPTIONS}
          />
          <Select
            label="有效期"
            value={String(expiresInDays)}
            onChange={(e) => setExpiresInDays(Number(e.target.value))}
            options={SHARE_EXPIRY_OPTIONS}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (deleteId) del.mutate(deleteId);
          setDeleteId(null);
        }}
        title="删除分享"
        message="删除后，这个公开链接会立即失效。此操作无法撤销。"
        confirmLabel="删除"
        tone="danger"
        loading={del.isPending}
      />
    </>
  );
}

function AppearanceSection() {
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);

  return (
    <Card title="主题" description="主题保存在本机，退出登录后仍然保留，并跟随本设备的偏好。">
      <p className="mb-3 text-xs text-ink-soft">选择一个视觉主题，应用到界面配色与字体。</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {THEMES.map((t) => {
          const active = mode === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setMode(t.value)}
              aria-pressed={active}
              aria-label={`主题：${t.label}`}
              className={cx(
                'flex flex-col gap-2 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                active
                  ? 'border-brand bg-brand-soft/35 ring-1 ring-brand/50'
                  : 'border-line bg-surface hover:border-line-strong',
              )}
            >
              {/* Mini preview block in that theme's palette */}
              <span
                className="flex h-12 w-full items-end overflow-hidden rounded-md border border-line p-1.5"
                style={{ background: t.swatch.canvas, borderColor: t.family === 'dark' ? '#00000033' : undefined }}
                aria-hidden
              >
                <span
                  className="h-4 flex-1 rounded-sm"
                  style={{ background: t.swatch.surface, border: '1px solid ' + t.swatch.canvas }}
                />
                <span className="ml-1 h-4 w-4 rounded-sm" style={{ background: t.swatch.accent }} />
                <span
                  className="ml-1 h-1.5 w-6 rounded-full opacity-80"
                  style={{ background: t.swatch.ink }}
                />
              </span>
              <span className="flex items-center justify-between gap-1">
                <span className="text-sm font-medium text-ink">{t.label}</span>
                {active && <Palette size={14} className="text-brand-ink" aria-label="当前主题" />}
              </span>
              <span className="text-2xs leading-tight text-ink-faint">{t.hint}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

const PROVIDER_OPTIONS: { value: AiProvider; label: string }[] = [
  { value: 'none', label: '未选择' },
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'custom', label: '自定义端点' },
];

/**
 * The AI panel is wired end-to-end to storage but performs no inference.
 *
 * This is a deliberate product decision, not an oversight: the settings
 * persist, so switching the feature on later is a server-side change with no
 * migration. The banner says so plainly rather than letting users discover a
 * dead switch.
 */
function AiSection() {
  const { data, isLoading } = useAiSettings();
  const update = useUpdateAiSettings();

  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  if (isLoading || !data) {
    return (
      <Card title="AI 助手">
        <Skeleton className="h-40 w-full" />
      </Card>
    );
  }

  const currentProvider = provider ?? data.provider;
  const currentBaseUrl = baseUrl ?? data.baseUrl ?? '';
  const currentModel = model ?? data.model ?? '';

  return (
    <>
      <section className="mb-4 flex items-start gap-2.5 rounded-md border border-caution bg-caution-soft px-4 py-3">
        <Sparkles size={16} className="mt-px shrink-0 text-caution-ink" aria-hidden />
        <div>
          <p className="text-sm font-medium text-caution-ink">功能入口已预留，尚未接入模型</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">
            这里的配置会被完整保存。等模型接入之后，自动摘要和自动打标签会立即生效，不需要重新设置。
          </p>
        </div>
      </section>

      <Card title="模型配置">
        <div className="flex flex-col gap-3.5">
          <Select
            label="服务商"
            value={currentProvider}
            onChange={(e) => setProvider(e.target.value as AiProvider)}
            options={PROVIDER_OPTIONS}
          />

          <Input
            label="接口地址"
            value={currentBaseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            disabled={currentProvider === 'none'}
          />

          <Input
            label="模型名称"
            value={currentModel}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            disabled={currentProvider === 'none'}
          />

          <Input
            label="API Key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={data.hasApiKey ? '已保存（留空则不修改）' : 'sk-…'}
            hint="加密存储在服务端，写入后不会再返回给浏览器。"
            disabled={currentProvider === 'none'}
          />

          <Button
            variant="primary"
            className="self-start"
            loading={update.isPending}
            onClick={() =>
              update.mutate({
                provider: currentProvider,
                baseUrl: currentBaseUrl || null,
                model: currentModel || null,
                ...(apiKey ? { apiKey } : {}),
              })
            }
          >
            保存配置
          </Button>
        </div>
      </Card>

      <Card title="自动化">
        <div className="flex flex-col gap-3">
          <Switch
            checked={data.autoSummarize}
            onChange={(next) => update.mutate({ autoSummarize: next })}
            label="自动生成摘要"
            hint="保存书签时生成一段内容摘要"
            disabled={currentProvider === 'none'}
          />
          <div className="h-px bg-line" />
          <Switch
            checked={data.autoTag}
            onChange={(next) => update.mutate({ autoTag: next })}
            label="自动推荐标签"
            hint="根据网页内容推荐 1–3 个标签"
            disabled={currentProvider === 'none'}
          />
        </div>
      </Card>
    </>
  );
}

function ShortcutsSection() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];

  return (
    <>
      {groups.map((group) => (
        <Card key={group} title={group}>
          <ul className="flex flex-col gap-2">
            {SHORTCUTS.filter((s) => s.group === group).map((shortcut) => (
              <li
                key={shortcut.description}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <span className="text-ink-soft">{shortcut.description}</span>
                <span className="flex shrink-0 gap-1">
                  {shortcut.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}

function AboutSection() {
  return (
    <Card title="关于 TagNest">
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-soft">
        <p>
          TagNest 是一个键盘优先的书签管理器，跑在 Cloudflare 上。数据属于你，随时可以完整导出。
        </p>
        <dl className="flex flex-col gap-2 border-t border-line pt-3 text-xs">
          <div className="flex justify-between">
            <dt>版本</dt>
            <dd className="tabular-nums text-ink">1.0.0</dd>
          </div>
          <div className="flex justify-between">
            <dt>许可证</dt>
            <dd>
              <Badge tone="positive">MIT</Badge>
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>运行环境</dt>
            <dd className="text-ink">Cloudflare Pages + D1</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

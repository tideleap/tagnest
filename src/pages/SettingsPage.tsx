import { useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { Info, Keyboard, Palette, Sparkles, User } from 'lucide-react';
import type { AiProvider } from '@shared/types';
import {
  Badge,
  Button,
  Input,
  Kbd,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
} from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { useTheme } from '@/stores/ui';
import type { ThemeMode } from '@/stores/ui';
import { useAiSettings, useStats, useUpdateAiSettings } from '@/hooks/queries';
import { SHORTCUTS } from '@/hooks/useGlobalHotkeys';
import { cx } from '@/lib/cx';

const SECTIONS = [
  { id: 'account', label: '账户', icon: User },
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

function AppearanceSection() {
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);

  return (
    <Card title="主题" description="主题保存在本机，退出登录后仍然保留。">
      <SegmentedControl<ThemeMode>
        label="主题模式"
        value={mode}
        onChange={setMode}
        segments={[
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
          { value: 'system', label: '跟随系统' },
        ]}
      />
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

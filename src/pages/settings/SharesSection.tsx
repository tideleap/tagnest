import { useState } from 'react';
import { Copy, ExternalLink, Pencil, Share2, Trash2 } from 'lucide-react';
import type { Share, ShareInput, SharePalette, ShareTheme } from '@shared/types';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  TagChip,
  Textarea,
  toast,
} from '@/components/ui';
import {
  useCollections,
  useCreateShare,
  useDeleteShare,
  useShares,
  useTags,
  useUpdateShare,
} from '@/hooks/queries';
import { relativeTime } from '@/lib/url';
import { Card } from './Card';

/* ------------------------------------------------------------------ *
 * Public shares (O7)
 * ------------------------------------------------------------------ */

const SHARE_THEME_OPTIONS: { value: ShareTheme; label: string }[] = [
  { value: 'default', label: '默认列表' },
  { value: 'compact', label: '紧凑列表' },
  { value: 'cards', label: '卡片网格' },
];

const SHARE_PALETTE_OPTIONS: { value: SharePalette; label: string }[] = [
  { value: 'light', label: '暖白经典' },
  { value: 'starlight', label: '星空白昼' },
  { value: 'blossom', label: '暖白樱粉' },
  { value: 'dark', label: '深空午夜' },
  { value: 'aurora', label: '极夜青蓝' },
];

const SHARE_PALETTE_LABEL: Record<SharePalette, string> = {
  light: '暖白',
  starlight: '星空白昼',
  blossom: '樱粉',
  dark: '深空',
  aurora: '极夜青蓝',
};

/**
 * Sentinel meaning "leave the stored expiry alone".
 *
 * The API reads `expiresInDays: 0` as "never expires" and writes `expires_at`
 * to NULL. When editing an existing share we therefore have to *omit* the field
 * entirely, otherwise saving an unrelated change (a new title, say) would
 * silently promote a link that was meant to lapse into a permanent one.
 */
const EXPIRY_KEEP = 'keep';

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

export function SharesSection() {
  const { data: shares, isLoading } = useShares();
  const { data: tags } = useTags();
  const { data: collections } = useCollections();
  const create = useCreateShare();
  const update = useUpdateShare();
  const del = useDeleteShare();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Share | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  /** Content source: a tag query or a whole collection. */
  const [sourceMode, setSourceMode] = useState<'tags' | 'collection'>('tags');
  const [collectionId, setCollectionId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [matchAllTags, setMatchAllTags] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [theme, setTheme] = useState<ShareTheme>('default');
  const [palette, setPalette] = useState<SharePalette>('light');
  const [isActive, setIsActive] = useState(true);
  /** Raw select value: `EXPIRY_KEEP` or a day count as a string. */
  const [expiry, setExpiry] = useState('0');
  /** Visitor password. `hasPassword` tracks whether the edited share already has one. */
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [removePassword, setRemovePassword] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setTitle('');
    setSlug('');
    setDescription('');
    setSourceMode('tags');
    setCollectionId('');
    setTagIds([]);
    setMatchAllTags(false);
    setIncludeNotes(true);
    setTheme('default');
    setPalette('light');
    setIsActive(true);
    setExpiry('0');
    setPassword('');
    setHasPassword(false);
    setRemovePassword(false);
    setShowForm(true);
  };

  const openEdit = (s: Share) => {
    setEditing(s);
    setTitle(s.title);
    setSlug(s.slug);
    setDescription(s.description ?? '');
    setSourceMode(s.collectionId ? 'collection' : 'tags');
    setCollectionId(s.collectionId ?? '');
    setTagIds(s.tagIds);
    setMatchAllTags(s.matchAllTags);
    setIncludeNotes(s.includeNotes);
    setTheme(s.theme);
    setPalette(s.palette);
    setIsActive(s.isActive);
    // Preserve whatever deadline is already stored unless the user picks a new
    // one; a share with no deadline simply starts on "never expires".
    setExpiry(s.expiresAt ? EXPIRY_KEEP : '0');
    setPassword('');
    setHasPassword(s.hasPassword);
    setRemovePassword(false);
    setShowForm(true);
  };

  const toggleTag = (id: string) =>
    setTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submitting = create.isPending || update.isPending;

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;

    // Password semantics mirror expiresInDays: omit = leave stored value alone.
    // A typed password sets/replaces; the remove checkbox clears it; otherwise
    // the field is omitted entirely so unrelated edits never strip it.
    const passwordPatch =
      password.length > 0
        ? { password }
        : removePassword && hasPassword
          ? { password: null }
          : {};

    const input: ShareInput = {
      title: trimmed,
      slug: slug.trim() || undefined,
      description: description.trim() || null,
      // Collection mode wins: the backend clears tag_ids when a collection is
      // chosen, and tag mode clears collection_id by passing null.
      ...(sourceMode === 'collection' && collectionId
        ? { collectionId, tagIds: [] }
        : { collectionId: null, tagIds, matchAllTags }),
      includeNotes,
      theme,
      palette,
      isActive,
      // Omitted entirely on `keep`, so the server leaves `expires_at` untouched.
      ...(expiry === EXPIRY_KEEP ? {} : { expiresInDays: Number(expiry) }),
      ...passwordPatch,
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
        description="把指定标签下的书签或整个集合整理成一个只读页面，任何人都能通过链接访问。分享的是实时查询结果，不是快照；可选设置访问密码。"
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
                    {s.hasPassword && <Badge tone="caution">密码保护</Badge>}
                    <Badge>{SHARE_THEME_LABEL[s.theme]}</Badge>
                    <Badge tone="neutral">{SHARE_PALETTE_LABEL[s.palette]}</Badge>
                    {s.collectionId ? (
                      <span className="text-2xs text-ink-faint">集合分享</span>
                    ) : (
                      s.tagIds.length > 0 && (
                        <span className="text-2xs text-ink-faint">
                          {s.tagIds.length} 个标签筛选
                        </span>
                      )
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

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-ink-soft">内容来源</span>
            <SegmentedControl
              label="内容来源"
              value={sourceMode}
              onChange={setSourceMode}
              segments={[
                { value: 'tags', label: '按标签筛选' },
                { value: 'collection', label: '指定集合' },
              ]}
              size="sm"
            />
          </div>

          {sourceMode === 'collection' ? (
            <Select
              label="选择集合"
              value={collectionId}
              onChange={(e) => setCollectionId(e.target.value)}
              options={[
                { value: '', label: '请选择集合…' },
                ...(collections ?? []).map((c) => ({ value: c.id, label: c.name })),
              ]}
              hint="分享该集合内的全部书签（按集合顺序），私密与已删除书签自动排除。"
            />
          ) : (
            tags &&
            tags.length > 0 && (
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
            )
          )}

          {sourceMode === 'tags' && (
            <Switch
              checked={matchAllTags}
              onChange={setMatchAllTags}
              label="需同时满足所有标签"
              hint="开启后，只有带全部所选标签的书签才会出现"
            />
          )}
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

          <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken/40 p-3">
            <Input
              label="访问密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasPassword ? '留空则保持当前密码' : '可留空，任何人可访问'}
              autoComplete="new-password"
              hint={
                hasPassword && !password && !removePassword
                  ? '当前已设置密码；留空保持不变，或输入新密码替换。'
                  : '设置后，访客需输入密码才能查看分享页内容。'
              }
            />
            {hasPassword && (
              <Checkbox
                checked={removePassword}
                onChange={(e) => setRemovePassword(e.target.checked)}
                label="移除密码（改为公开访问）"
              />
            )}
          </div>

          <Select
            label="主题"
            value={theme}
            onChange={(e) => setTheme(e.target.value as ShareTheme)}
            options={SHARE_THEME_OPTIONS}
          />
          <Select
            label="配色"
            value={palette}
            onChange={(e) => setPalette(e.target.value as SharePalette)}
            options={SHARE_PALETTE_OPTIONS}
          />
          <Select
            label="有效期"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            options={
              editing?.expiresAt
                ? [
                    {
                      value: EXPIRY_KEEP,
                      label: `保持不变（${relativeTime(editing.expiresAt)}过期）`,
                    },
                    ...SHARE_EXPIRY_OPTIONS,
                  ]
                : SHARE_EXPIRY_OPTIONS
            }
            hint={
              expiry === EXPIRY_KEEP
                ? '沿用当前到期时间，本次保存不会改变它。'
                : expiry === '0'
                  ? '链接将长期有效，直到你手动停用或删除。'
                  : `保存后重新计时，自今天起 ${expiry} 天后失效。`
            }
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

import { useState } from 'react';
import { Copy, ExternalLink, Pencil, Share2, Trash2 } from 'lucide-react';
import type { Share, ShareInput, ShareTheme } from '@shared/types';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Modal,
  Select,
  Skeleton,
  Switch,
  TagChip,
  Textarea,
  toast,
} from '@/components/ui';
import {
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

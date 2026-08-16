import { useState } from 'react';
import { RefreshCw, Rss, Trash2 } from 'lucide-react';
import type { Feed, FeedCadence } from '@shared/types';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';
import type { SelectOption } from '@/components/ui';
import { TagPicker } from '@/components/bookmark/TagPicker';
import { Reveal } from '@/components/atelier';
import { displayHost } from '@/lib/url';
import {
  useFeeds,
  useRefreshAllFeeds,
  useRefreshFeed,
  useSubscribeFeed,
  useUnsubscribeFeed,
} from '@/hooks/queries/feeds';

const CADENCE_OPTIONS: SelectOption[] = [
  { value: 'off', label: '仅手动' },
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
];

/** Human-readable label + badge tone for a feed's last fetch status. */
function statusView(status: string | null): { label: string; tone: 'neutral' | 'positive' | 'caution' } {
  if (!status) return { label: '未拉取', tone: 'neutral' };
  if (status === 'ok') return { label: '正常', tone: 'positive' };
  if (status === 'never') return { label: '未拉取', tone: 'neutral' };
  if (status === 'empty') return { label: '无新条目', tone: 'neutral' };
  if (status.startsWith('http_')) return { label: `源错误 ${status.replace('http_', '')}`, tone: 'caution' };
  if (status === 'feed_blocked_host') return { label: '地址被拦截', tone: 'caution' };
  if (status === 'feed_fetch_failed') return { label: '拉取失败', tone: 'caution' };
  if (status === 'feed_invalid_url') return { label: '地址无效', tone: 'caution' };
  return { label: status, tone: 'neutral' };
}

function formatWhen(iso: string | null): string {
  if (!iso) return '从未';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '从未';
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function FeedsPage() {
  const { data: feeds, isLoading } = useFeeds();
  const subscribe = useSubscribeFeed();
  const unsubscribe = useUnsubscribeFeed();
  const refresh = useRefreshFeed();
  const refreshAll = useRefreshAllFeeds();

  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [cadence, setCadence] = useState<FeedCadence>('off');

  const resetForm = () => {
    setUrl('');
    setTitle('');
    setTagNames([]);
    setCadence('off');
  };

  const onSubscribe = () => {
    if (!url.trim()) {
      subscribe.reset();
      return;
    }
    subscribe.mutate(
      { url: url.trim(), title: title.trim() || undefined, tagNames, cadence },
      { onSuccess: resetForm },
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        icon={<Rss size={14} aria-hidden />}
        eyebrow="自动收集"
        index="13 / 16"
        title="RSS 订阅"
        description="订阅喜欢的站点，新文章会自动存为书签并按标签归类。"
      />

      <Reveal as="section" delay={80} className="flex flex-col gap-3 rounded-xl border border-line bg-surface/85 p-5 shadow-raised backdrop-blur-sm">
        <h2 className="font-display text-[0.95rem] font-semibold tracking-tight text-ink">添加订阅</h2>
        <Input
          label="订阅源地址"
          placeholder="https://example.com/feed.xml"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubscribe();
          }}
        />
        <Input
          label="标题（可选）"
          hint="留空则使用站点域名"
          placeholder="留空自动识别"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TagPicker value={tagNames} onChange={setTagNames} label="默认标签" hint="拉取到的书签会自动打上这些标签" />
        <Select
          label="刷新频率"
          options={CADENCE_OPTIONS}
          value={cadence}
          onChange={(e) => setCadence(e.target.value as FeedCadence)}
        />
        <div className="flex justify-end">
          <Button
            variant="primary"
            iconLeft={<Rss size={16} />}
            onClick={onSubscribe}
            loading={subscribe.isPending}
            disabled={!url.trim()}
          >
            订阅
          </Button>
        </div>
      </Reveal>

      <Reveal as="section" delay={140} className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[0.95rem] font-semibold tracking-tight text-ink">我的订阅</h2>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<RefreshCw size={14} />}
            onClick={() => refreshAll.mutate()}
            loading={refreshAll.isPending}
            disabled={!feeds || feeds.length === 0}
          >
            刷新全部
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-ink-faint">
            <Spinner size={22} />
          </div>
        ) : !feeds || feeds.length === 0 ? (
          <EmptyState
            icon={<Rss size={20} />}
            title="还没有订阅"
            description="添加一个 RSS / Atom 地址，新内容会自动进入你的书签库。"
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {feeds.map((feed: Feed) => {
              const st = statusView(feed.lastStatus);
              return (
                <li
                  key={feed.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-ink">{feed.title || feed.url}</p>
                      <Badge tone="neutral">{CADENCE_OPTIONS.find((o) => o.value === feed.cadence)?.label}</Badge>
                    </div>
                    <p className="truncate text-xs text-ink-soft">{displayHost(feed.url)}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-ink-faint">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      <span>上次拉取：{formatWhen(feed.lastFetchedAt)}</span>
                      {feed.tagNames.length > 0 && (
                        <span className="truncate">· 标签：{feed.tagNames.join('、')}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconLeft={<RefreshCw size={14} />}
                      onClick={() => refresh.mutate(feed.id)}
                      loading={refresh.isPending && refresh.variables === feed.id}
                    >
                      刷新
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconLeft={<Trash2 size={14} />}
                      onClick={() => unsubscribe.mutate(feed.id)}
                      loading={unsubscribe.isPending && unsubscribe.variables === feed.id}
                    >
                      退订
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Reveal>
    </div>
  );
}

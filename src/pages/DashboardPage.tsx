import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  FolderOpen,
  Inbox,
  Plus,
  Sparkles,
  Star,
  Stethoscope,
  Tag as TagIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import { useStats, useBookmarks, useTags, useHealthReport } from '@/hooks/queries';
import { Button, Skeleton, TagChip } from '@/components/ui';
import { RemoteImage } from '@/components/ui';
import { CartoonMascot } from '@/components/decor/CartoonMascot';
import { KineticText, Magnetic, Reveal, Stagger, TiltCard } from '@/components/atelier';
import { displayHost, faviconFor, relativeTime } from '@/lib/url';

const TILE = ['#6366f1', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6', '#f59e0b', '#f97316', '#ef4444'];

function Hero({
  total,
  added,
  loading,
  failed,
}: {
  total?: number;
  added?: number;
  loading?: boolean;
  failed?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <section className="atelier-edge relative overflow-hidden rounded-2xl border border-line bg-surface/70 p-6 shadow-float backdrop-blur-sm sm:p-9">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-brand-soft/60 blur-[80px]" />
        <div className="absolute -bottom-24 left-1/4 h-60 w-60 rounded-full bg-brand-accent/10 blur-[70px]" />
      </div>

      <Reveal className="relative flex flex-col items-start gap-8 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 max-w-2xl">
          <p className="atelier-eyebrow">
            <Sparkles size={13} aria-hidden /> 我的书签小天地
          </p>
          <h1 className="atelier-display atelier-display--1 mt-4 text-ink">
            你的书签，<span className="atelier-serif atelier-gradient-text">自有秩序</span>。
          </h1>

          <p className="mt-5 max-w-md text-base leading-relaxed text-ink-soft">
            {failed ? (
              '没能读取到统计数据，你的书签都还在。稍后重试即可。'
            ) : (
              <>
                当前共收藏
                <span className="mx-1 font-bold tabular-nums text-brand-ink">
                  {loading ? '…' : (total ?? 0).toLocaleString()}
                </span>
                条；最近 7 天新增
                <span className="mx-1 font-bold tabular-nums text-brand-accent">
                  {loading ? '…' : added ?? 0}
                </span>
                条。
              </>
            )}
          </p>

          <div className="mt-7 flex flex-wrap gap-3">
            <Magnetic strength={0.35}>
              <Button
                variant="primary"
                size="lg"
                iconLeft={<Plus size={16} aria-hidden />}
                onClick={() => navigate('/library/inbox')}
              >
                添加书签
              </Button>
            </Magnetic>
            <Magnetic strength={0.35}>
              <Button
                variant="secondary"
                size="lg"
                iconLeft={<Upload size={16} aria-hidden />}
                onClick={() => navigate('/import')}
              >
                导入书签
              </Button>
            </Magnetic>
          </div>
        </div>

        <div className="relative shrink-0">
          <CartoonMascot size={120} />
          <p className="mt-1 text-center text-2xs text-ink-faint">Nesty 陪你看书签</p>
        </div>
      </Reveal>
    </section>
  );
}

function AttentionCard({
  icon,
  label,
  hint,
  count,
  loading,
  failed,
  to,
  color,
  index,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  count?: number;
  loading?: boolean;
  failed?: boolean;
  to: string;
  color: string;
  index: number;
}) {
  return (
    <Reveal delay={index * 60}>
      <TiltCard className="h-full">
        <Link
          to={to}
          className="spotlight group flex h-full items-center gap-4 rounded-2xl border border-line bg-surface p-4 shadow-float transition-colors hover:border-brand-accent"
        >
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-raised"
            style={{ backgroundColor: color }}
          >
            {icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-bold text-ink">{label}</span>
              {count !== undefined && (
                <span className="text-2xl font-extrabold tabular-nums leading-none" style={{ color }}>
                  {loading ? <Skeleton className="h-7 w-8" /> : count}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-2xs text-ink-faint">
              {failed ? '数据暂不可用' : hint}
            </span>
          </span>
          <ArrowUpRight
            size={16}
            className="shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-brand-ink"
            aria-hidden
          />
        </Link>
      </TiltCard>
    </Reveal>
  );
}

function StatCard({
  label,
  value,
  loading,
  failed,
  to,
  color,
  index,
}: {
  label: string;
  value?: number;
  loading?: boolean;
  failed?: boolean;
  to: string;
  color: string;
  index: number;
}) {
  return (
    <Reveal delay={index * 60}>
      <TiltCard className="h-full" max={7}>
        <Link
          to={to}
          className="spotlight block h-full rounded-2xl border border-line bg-surface p-5 shadow-float transition-colors hover:border-brand-accent"
        >
          <span
            className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl text-white"
            style={{ backgroundColor: color }}
          >
            <span className="block h-2 w-2 rounded-full bg-white/90" aria-hidden />
          </span>
          <p className="text-3xl font-extrabold tabular-nums leading-none text-ink">
            {loading ? <Skeleton className="h-8 w-14" /> : failed ? '—' : (value ?? 0).toLocaleString()}
          </p>
          <p className="mt-1.5 text-xs font-medium text-ink-soft">{label}</p>
        </Link>
      </TiltCard>
    </Reveal>
  );
}

function SectionHead({ index, title, note }: { index: string; title: string; note: string }) {
  return (
    <Reveal>
      <div className="mb-4 flex items-end justify-between gap-3">
        <h2 className="flex items-baseline gap-3 text-base font-extrabold text-ink">
          <span className="atelier-index">{index}</span>
          <span className="relative">
            {title}
            <span className="absolute -bottom-1 left-0 h-0.5 w-8 rounded-full bg-brand-accent" aria-hidden />
          </span>
        </h2>
        <span className="hidden text-2xs text-ink-faint sm:block">{note}</span>
      </div>
    </Reveal>
  );
}

/** Compact list of the most recently added bookmarks — gives the dashboard
 *  immediate substance instead of floating in whitespace. */
function RecentBookmarks() {
  const { data, isLoading, isError } = useBookmarks({ scope: 'all', sort: 'created_desc' });
  const items = (data?.pages[0]?.items ?? []).slice(0, 6);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[4.25rem] w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (isError || items.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-sm text-ink-faint">
        还没有书签，添加第一条开始搭建秩序。
      </p>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {items.map((b) => (
        <li key={b.id}>
          <Link
            to={`/library/all?focus=${b.id}`}
            className="spotlight group flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 transition-colors hover:border-brand-accent"
          >
            <span className="favicon-badge h-9 w-9 shrink-0 p-1.5">
              <RemoteImage
                src={faviconFor(b.url)}
                alt=""
                className="h-full w-full rounded"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">
                {b.title || b.url}
              </span>
              <span className="mt-0.5 block truncate text-2xs text-ink-faint">
                {displayHost(b.url)} · {b.createdAt ? relativeTime(b.createdAt) : ''}
              </span>
            </span>
            <ArrowUpRight
              size={15}
              className="shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-brand-ink"
              aria-hidden
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A wrap of the most-used tags, sized as a cloud — quick entry into the
 *  library and a second source of "what's in here" context. */
function TagCloud() {
  const { data: tags, isLoading } = useTags();
  const top = [...(tags ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 14);

  if (isLoading) {
    return (
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-16 rounded-full" />
        ))}
      </div>
    );
  }
  if (top.length === 0) {
    return (
      <p className="text-sm text-ink-faint">还没有标签。给书签打上标签后会出现在这里。</p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {top.map((t) => (
        <Link key={t.id} to={`/library/all?tagIds=${t.id}`} className="transition-transform hover:-translate-y-0.5">
          <TagChip name={t.name} colorIndex={t.colorIndex} size="sm" count={t.count} />
        </Link>
      ))}
    </div>
  );
}

/**
 * First-screen library health check. Surfaces the existing /bookmarks/health
 * report so users see redundancy / orphan-tag issues the moment they land,
 * instead of only discovering them on /organize or /report. This is the entry
 * point of the "free scan → clean up" funnel (auto-patrol later becomes a
 * Pro perk once the plan/upgrade surface exists).
 */
function HealthCard() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch, isFetching } = useHealthReport();
  const issues = (data?.duplicateExtra ?? 0) + (data?.orphanTags.length ?? 0);
  const score = data?.score ?? 0;
  const tone =
    score >= 90
      ? { color: '#14b8a6', label: '很健康' }
      : score >= 70
        ? { color: '#f59e0b', label: '有小问题' }
        : { color: '#ef4444', label: '需要清理' };

  return (
    <Reveal>
      <TiltCard className="h-full" max={6}>
        <section
          aria-label="书签体检"
          className="flex h-full flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-float sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-center gap-4">
            <span
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-raised"
              style={{ backgroundColor: tone.color }}
            >
              <Stethoscope size={22} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="flex items-baseline gap-2 text-sm font-bold text-ink">
                书签体检
                {!isLoading && !isError && (
                  <span className="text-2xs font-medium" style={{ color: tone.color }}>
                    {tone.label} · {score} 分
                  </span>
                )}
              </p>
              {isLoading ? (
                <Skeleton className="mt-1 h-4 w-40" />
              ) : isError ? (
                <p className="mt-1 text-2xs text-ink-faint">体检暂不可用，稍后重试</p>
              ) : issues > 0 ? (
                <p className="mt-0.5 truncate text-2xs text-ink-soft">
                  发现 {issues} 处可优化：{data?.duplicateExtra ?? 0} 条冗余书签 ·{' '}
                  {data?.orphanTags.length ?? 0} 个孤儿标签
                </p>
              ) : (
                <p className="mt-0.5 text-2xs text-ink-soft">你的书签库很整洁，继续保持</p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isError && (
              <Button size="sm" variant="secondary" onClick={() => void refetch()} loading={isFetching}>
                重试
              </Button>
            )}
            <Button
              size="sm"
              variant={issues > 0 ? 'primary' : 'secondary'}
              iconLeft={<ArrowUpRight size={15} aria-hidden />}
              onClick={() => navigate('/organize')}
            >
              {issues > 0 ? '去清理' : '查看详情'}
            </Button>
          </div>
        </section>
      </TiltCard>
    </Reveal>
  );
}

export function DashboardPage() {
  const stats = useStats();
  const s = stats.data;
  const loading = stats.isLoading;
  const failed = stats.isError;

  const attention = [
    { icon: <Inbox size={20} aria-hidden />, label: '收件箱', hint: s && s.untagged > 0 ? '先收进收件箱整理' : '收件箱已经清空了', count: s?.untagged, to: '/library/inbox', color: TILE[0] },
    { icon: <Trash2 size={20} aria-hidden />, label: '回收站', hint: s && s.trashed > 0 ? '删除的书签保留 30 天' : '回收站是空的', count: s?.trashed, to: '/library/trash', color: TILE[1] },
    { icon: <ArchiveIcon />, label: '归档', hint: '暂时用不到，先移出主视图', count: s?.archived, to: '/library/archive', color: TILE[2] },
    { icon: <Sparkles size={20} aria-hidden />, label: 'AI 整理', hint: s && s.untagged > 0 ? '让 AI 帮未打标书签生成标签' : '全库标签健康检查', count: undefined, to: '/organize', color: TILE[3] },
  ];

  const quickLinks = [
    { to: '/library/inbox', icon: <Inbox size={17} aria-hidden />, label: '收件箱' },
    { to: '/library/favorites', icon: <Star size={17} aria-hidden />, label: '收藏' },
    { to: '/library/archive', icon: <ArchiveIcon />, label: '归档' },
    { to: '/tags', icon: <TagIcon size={17} aria-hidden />, label: '管理标签' },
    { to: '/tab-groups', icon: <FolderOpen size={17} aria-hidden />, label: '标签页组' },
    { to: '/library/trash', icon: <Trash2 size={17} aria-hidden />, label: '回收站' },
    { to: '/import', icon: <Upload size={17} aria-hidden />, label: '导入导出' },
    { to: '/settings', icon: <Sparkles size={17} aria-hidden />, label: '设置' },
  ];

  return (
    <div className="relative mx-auto flex max-w-7xl flex-col gap-6 pb-14 pt-2">
      <Hero total={s?.bookmarks} added={s?.addedLast7Days} loading={loading} failed={failed} />

      {!loading && !failed && s?.bookmarks === 0 && (
        <div className="rounded-2xl border border-brand-soft bg-brand-soft/30 p-5 text-sm text-ink-soft">
          收藏夹还是空的——添加第一条书签，开始搭建你的秩序。
        </div>
      )}

      {failed && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-caution bg-caution-soft px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-ink-soft">统计数据加载失败，下面的数字暂时无法显示。这不影响你的书签数据。</p>
          <Button size="sm" variant="secondary" onClick={() => void stats.refetch()} loading={stats.isFetching}>
            重试
          </Button>
        </div>
      )}

      <section aria-label="需要处理">
        <SectionHead index="01" title="需要你处理" note="点一下就直奔那个分区" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {attention.map((a, i) => (
            <AttentionCard key={a.to} index={i} {...a} loading={loading} failed={failed} />
          ))}
        </div>
      </section>

      <section aria-label="书签体检">
        <SectionHead index="02" title="书签体检" note="一键看清库里的冗余与孤儿" />
        <HealthCard />
      </section>

      {/* Responsive composition: a wide main column + a slim right rail on
          desktop; both stack on phones and tablets. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <section aria-label="书签库构成">
            <SectionHead index="03" title="书签库构成" note="你的收藏形状" />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard index={0} label="全部书签" value={s?.bookmarks} loading={loading} failed={failed} to="/library/all" color={TILE[4]} />
              <StatCard index={1} label="收藏" value={s?.favorites} loading={loading} failed={failed} to="/library/favorites" color={TILE[5]} />
              <StatCard index={2} label="已归档" value={s?.archived} loading={loading} failed={failed} to="/library/archive" color={TILE[6]} />
              <StatCard index={3} label="标签" value={s?.tags} loading={loading} failed={failed} to="/tags" color={TILE[7]} />
            </div>
          </section>

          <section aria-label="最近添加">
            <SectionHead index="04" title="最近添加" note="最新的收藏，点开看全部" />
            <RecentBookmarks />
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <section aria-label="热门标签">
            <SectionHead index="05" title="热门标签" note="用得最多的标签" />
            <TagCloud />
          </section>

          <section aria-label="快捷入口">
            <SectionHead index="06" title="快捷入口" note="像翻杂志一样点着玩" />
            <Stagger className="grid grid-cols-2 gap-2.5">
              {quickLinks.map((a) => (
                <Link
                  key={a.to}
                  to={a.to}
                  className="spotlight flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-3 text-sm font-medium text-ink transition-colors hover:border-brand-accent hover:text-brand-ink"
                >
                  <span className="shrink-0 text-brand-ink">{a.icon}</span>
                  <span className="truncate">{a.label}</span>
                </Link>
              ))}
            </Stagger>
          </section>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line/60 bg-surface py-4">
        <KineticText duration={30} separator={<Sparkles size={14} className="text-brand-accent" aria-hidden />}>
          {['书签', '标签', 'AI 整理', '网页快照', '时间线', '集合', '检索', '归档'].map((w) => (
            <span key={w} className="flex items-center gap-2.5 text-sm font-medium tracking-wide text-ink-soft">
              {w}
              <span className="text-brand-accent">/</span>
            </span>
          ))}
        </KineticText>
      </div>
    </div>
  );
}

/* Small inline archive glyph kept local to avoid an extra import alias. */
function ArchiveIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </svg>
  );
}

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  FolderOpen,
  Inbox,
  Plus,
  Sparkles,
  Star,
  Tag as TagIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import { useStats } from '@/hooks/queries';
import { Button, Skeleton } from '@/components/ui';
import { CartoonMascot } from '@/components/decor/CartoonMascot';
import {
  KineticText,
  Magnetic,
  Reveal,
  Stagger,
  TiltCard,
} from '@/components/atelier';

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
  return (
    <section className="atelier-edge relative overflow-hidden rounded-2xl border border-line bg-surface/70 p-7 shadow-float backdrop-blur-sm sm:p-10">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-brand-soft/60 blur-[80px]" />
        <div className="absolute -bottom-24 left-1/4 h-60 w-60 rounded-full bg-brand-accent/10 blur-[70px]" />
      </div>

      <Reveal className="relative flex flex-col items-start gap-8 md:flex-row md:items-center md:justify-between">
        <div className="max-w-2xl">
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
              <Button variant="primary" size="lg" iconLeft={<Plus size={16} aria-hidden />}>
                <Link to="/library/inbox" className="contents">
                  添加书签
                </Link>
              </Button>
            </Magnetic>
            <Magnetic strength={0.35}>
              <Button variant="secondary" size="lg" iconLeft={<Upload size={16} aria-hidden />}>
                <Link to="/import" className="contents">
                  导入书签
                </Link>
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
        <span className="text-2xs text-ink-faint">{note}</span>
      </div>
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

  return (
    <div className="relative mx-auto flex max-w-5xl flex-col gap-10 pb-14 pt-2">
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
        <div className="grid gap-3 sm:grid-cols-2">
          {attention.map((a, i) => (
            <AttentionCard key={a.to} index={i} {...a} loading={loading} failed={failed} />
          ))}
        </div>
      </section>

      <section aria-label="书签库构成">
        <SectionHead index="02" title="书签库构成" note="你的收藏形状" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard index={0} label="全部书签" value={s?.bookmarks} loading={loading} failed={failed} to="/library/all" color={TILE[4]} />
          <StatCard index={1} label="收藏" value={s?.favorites} loading={loading} failed={failed} to="/library/favorites" color={TILE[5]} />
          <StatCard index={2} label="已归档" value={s?.archived} loading={loading} failed={failed} to="/library/archive" color={TILE[6]} />
          <StatCard index={3} label="标签" value={s?.tags} loading={loading} failed={failed} to="/tags" color={TILE[7]} />
        </div>
      </section>

      <div className="overflow-hidden rounded-2xl border border-line/60 bg-surface/50 py-4">
        <KineticText duration={30} separator={<Sparkles size={14} className="text-brand-accent" aria-hidden />}>
          {['书签', '标签', 'AI 整理', '网页快照', '时间线', '集合', '检索', '归档'].map((w) => (
            <span key={w} className="flex items-center gap-2.5 text-sm font-medium tracking-wide text-ink-soft">
              {w}
              <span className="text-brand-accent">/</span>
            </span>
          ))}
        </KineticText>
      </div>

      <section aria-label="快捷入口">
        <SectionHead index="03" title="快捷入口" note="像翻杂志一样点着玩" />
        <Stagger className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {[
            { to: '/library/inbox', icon: <Inbox size={17} aria-hidden />, label: '收件箱' },
            { to: '/library/favorites', icon: <Star size={17} aria-hidden />, label: '收藏' },
            { to: '/library/archive', icon: <ArchiveIcon />, label: '归档' },
            { to: '/tags', icon: <TagIcon size={17} aria-hidden />, label: '管理标签' },
            { to: '/tab-groups', icon: <FolderOpen size={17} aria-hidden />, label: '标签页组' },
            { to: '/library/trash', icon: <Trash2 size={17} aria-hidden />, label: '回收站' },
            { to: '/import', icon: <Upload size={17} aria-hidden />, label: '导入导出' },
            { to: '/settings', icon: <Sparkles size={17} aria-hidden />, label: '设置' },
          ].map((a) => (
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

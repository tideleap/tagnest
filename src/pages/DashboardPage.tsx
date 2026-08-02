import { Link } from 'react-router-dom';
import {
  Archive,
  ArrowRight,
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
import { DecorBlob, DottedBg, Reveal, Scribble } from '@/components/decor';

/**
 * B8 — 概览页 (/dashboard) — 卡通涂鸦版
 *
 * 视觉方向：活泼明快的卡通插画。首页从"安静的动作引擎"升级为"有一点自家
 * 小精灵的家的感觉"。原则：
 *   - 卡通元素（吉祥物、波点、手绘下划线、彩色 blob 背景）只做"装饰外衣"，
 *     信息层级（数字、标签、可点卡片）保持高可读，不让乐趣压过任务。
 *   - 交互全部走 transform/opacity（合成器友好），滚动进场用一次性的
 *     IntersectionObserver，按钮点击用 CSS 波纹——不引入动效库，保住体积。
 *   - 所有动效在 prefers-reduced-motion 下自动禁用（见 index.css）。
 * 数据仍来自既有 /stats 端点，零新增后端。
 */

const PASTEL = ['#ffb3c1', '#ffd6a5', '#fff3b0', '#b8f2c9', '#bde0fe', '#e2c9ff'];

function MascotHero({
  total,
  added,
  loading,
}: {
  total?: number;
  added?: number;
  loading?: boolean;
}) {
  return (
    <section
      aria-label="概览"
      className="relative overflow-hidden rounded-2xl border border-line bg-surface p-6 shadow-float sm:p-8"
    >
      {/* Soft brand wash so the hero reads as "the page's anchor" — the warm
          corner of the room. Lifts the flat card into the modern glow. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-brand-soft/70 blur-[64px]" />
        <div className="absolute -bottom-20 left-1/4 h-48 w-48 rounded-full bg-brand-accent/10 blur-[60px]" />
      </div>
      {/* cartoon ground fill: dotted texture + drift blobs */}
      <DottedBg className="text-brand-ink" />
      <DecorBlob className="-left-10 -top-12 h-40 w-40" color="#ffd6a5" />
      <DecorBlob className="-right-12 -top-8 h-44 w-44" color="#bde0fe" />
      <DecorBlob className="bottom-0 left-1/2 h-32 w-40 -translate-x-1/2" color="#b8f2c9" />

      {/* spinning sun accent (pure decoration) */}
      <Sparkles
        aria-hidden
        size={30}
        className="decor-spin-slow absolute right-4 top-4 text-caution"
      />

      <div className="relative flex flex-col items-start gap-6 md:flex-row md:items-center md:justify-between">
        <div className="max-w-xl">
          <p className="mb-2 inline-flex items-center rounded-full bg-brand-soft px-3 py-1 text-2xs font-semibold text-brand-ink">
            <Sparkles size={12} className="mr-1" aria-hidden />
            我的书签小天地
          </p>
          <h1 className="relative inline-block text-4xl font-extrabold tracking-tight text-ink">
            {loading ? <Skeleton className="h-11 w-48" /> : `${total ?? 0} 条书签`}
            <Scribble className="text-brand-accent" />
          </h1>
          <p className="mt-3 max-w-md text-base leading-relaxed text-ink-soft">
            最近 7 天新增了
            <span className="mx-1 font-bold tabular-nums text-brand-accent">
              {loading ? '…' : added ?? 0}
            </span>
            条。有收藏的地方，就有家的感觉。
          </p>

          <div className="mt-5 flex flex-wrap gap-2.5">
            <Button variant="primary" size="md" className="btn-ripple" iconLeft={<Plus size={15} aria-hidden />}>
              <Link to="/library/inbox" className="contents">
                添加书签
              </Link>
            </Button>
            <Button variant="secondary" size="md" className="btn-ripple" iconLeft={<Upload size={15} aria-hidden />}>
              <Link to="/import" className="contents">
                导入书签
              </Link>
            </Button>
          </div>
        </div>

        {/* Mascot — the happy point of the page. Floats idle, wiggles on hover,
            pops on click, and can be dragged as a tiny easter egg. */}
        <div className="relative mx-auto shrink-0 md:mx-0">
          <CartoonMascot size={112} />
          <p className="mt-1 text-center text-2xs text-ink-faint">Nesty 陪你看书签～</p>
        </div>
      </div>
    </section>
  );
}

function AttentionCard({
  icon,
  label,
  hint,
  count,
  loading,
  to,
  color,
  index,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  count?: number;
  loading?: boolean;
  to: string;
  color: string;
  index: number;
}) {
  return (
    <Reveal delay={index * 50}>
      <Link
        to={to}
        className="attention-card group flex items-center gap-4 rounded-2xl border-2 border-line bg-surface p-4 shadow-float transition-all hover:-translate-y-1 hover:border-brand-accent hover:shadow-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-raised"
          style={{ backgroundColor: color }}
        >
          <span className="mascot-idle">{icon}</span>
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
          <span className="mt-0.5 block truncate text-2xs text-ink-faint">{hint}</span>
        </span>
        <ArrowRight
          size={16}
          className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </Link>
    </Reveal>
  );
}

function StatCard({
  label,
  value,
  loading,
  to,
  color,
  index,
}: {
  label: string;
  value?: number;
  loading?: boolean;
  to: string;
  color: string;
  index: number;
}) {
  return (
    <Reveal delay={index * 50}>
      <Link
        to={to}
        className="stat-card block rounded-2xl border-2 border-line bg-surface p-5 shadow-float transition-all hover:-translate-y-1 hover:scale-[1.02] hover:border-brand-accent hover:shadow-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span
          className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl text-white"
          style={{ backgroundColor: color }}
        >
          {/* tiny floating dot — decorative fill near the number */}
          <span className="mascot-idle block h-2 w-2 rounded-full bg-white/90" aria-hidden />
        </span>
        <p className="text-3xl font-extrabold tabular-nums leading-none text-ink">
          {loading ? <Skeleton className="h-8 w-14" /> : value ?? 0}
        </p>
        <p className="mt-1.5 text-xs font-medium text-ink-soft">{label}</p>
      </Link>
    </Reveal>
  );
}

export function DashboardPage() {
  const stats = useStats();
  const s = stats.data;
  const loading = stats.isLoading;

  // Deterministic per-card palette (stable across renders, no flash).
  const attention = [
    {
      icon: <Inbox size={20} aria-hidden />,
      label: '待打标书签',
      hint: s && s.untagged > 0 ? '先收进收件箱整理' : '收件箱是满整理的',
      count: s?.untagged,
      to: '/library/inbox',
      color: PASTEL[0],
    },
    {
      icon: <Trash2 size={20} aria-hidden />,
      label: '回收站',
      hint: s && s.trashed > 0 ? '删除的书签保留 30 天' : '回收站是空的',
      count: s?.trashed,
      to: '/library/trash',
      color: PASTEL[1],
    },
    {
      icon: <Archive size={20} aria-hidden />,
      label: '已归档',
      hint: '暂时用不到，先移出主视图',
      count: s?.archived,
      to: '/library/archive',
      color: PASTEL[2],
    },
    {
      icon: <Sparkles size={20} aria-hidden />,
      label: 'AI 整理',
      hint: s && s.untagged > 0 ? '让 AI 帮待打标书签生成标签' : '全库标签健康检查',
      count: undefined,
      to: '/organize',
      color: PASTEL[3],
    },
  ];

  return (
    <div className="relative mx-auto flex max-w-5xl flex-col gap-8 px-4 pb-12 pt-2">
      {/* Overview hero — cartoon, warm, anchored by the mascot. */}
      <MascotHero total={s?.bookmarks} added={s?.addedLast7Days} loading={loading} />

      {/* Needs attention — interactive pastel cards. */}
      <section aria-label="需要处理">
        <Reveal>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-base font-extrabold text-ink">
              需要你处理
              <span className="ml-2 inline-block h-2.5 w-2.5 rounded-full bg-brand-accent" aria-hidden />
            </h2>
            <span className="text-2xs text-ink-faint">点一下就直奔那个分区</span>
          </div>
        </Reveal>
        <div className="grid gap-3 sm:grid-cols-2">
          {attention.map((a, i) => (
            <AttentionCard key={a.to} index={i} {...a} loading={loading} />
          ))}
        </div>
      </section>

      {/* Library shape — colourful stat cards. */}
      <section aria-label="书签库构成">
        <Reveal>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-base font-extrabold text-ink">
              书签库构成
              <Scribble className="text-caution" />
            </h2>
            <span className="text-2xs text-ink-faint">你的收藏形状</span>
          </div>
        </Reveal>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard index={0} label="全部书签" value={s?.bookmarks} loading={loading} to="/library/all" color="#ff6b81" />
          <StatCard index={1} label="收藏" value={s?.favorites} loading={loading} to="/library/favorites" color="#ffa94d" />
          <StatCard index={2} label="已归档" value={s?.archived} loading={loading} to="/library/archive" color="#66c2ff" />
          <StatCard index={3} label="标签" value={s?.tags} loading={loading} to="/tags" color="#69db7c" />
        </div>
      </section>

      {/* Quick jump — cheerful, dotted, zesty. */}
      <section aria-label="快捷入口">
        <Reveal>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-base font-extrabold text-ink">快捷入口</h2>
            <span className="text-2xs text-ink-faint">像翻漫画一样点着玩</span>
          </div>
        </Reveal>
        <div className="relative overflow-hidden rounded-2xl border-2 border-dashed border-line-strong bg-surface/60 p-4">
          <DottedBg className="text-brand-ink" />
          <div className="relative grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {[
              { to: '/library/inbox', icon: <Inbox size={17} aria-hidden />, label: '收件箱' },
              { to: '/library/favorites', icon: <Star size={17} aria-hidden />, label: '收藏' },
              { to: '/library/archive', icon: <Archive size={17} aria-hidden />, label: '归档' },
              { to: '/tags', icon: <TagIcon size={17} aria-hidden />, label: '管理标签' },
              { to: '/tab-groups', icon: <FolderOpen size={17} aria-hidden />, label: '标签页组' },
              { to: '/library/trash', icon: <Trash2 size={17} aria-hidden />, label: '回收站' },
              { to: '/import', icon: <Upload size={17} aria-hidden />, label: '导入导出' },
              { to: '/settings', icon: <Sparkles size={17} aria-hidden />, label: '设置' },
            ].map((a, i) => (
              <Reveal key={a.to} delay={i * 30}>
                <Link
                  to={a.to}
                  className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-all hover:-translate-y-0.5 hover:border-brand-accent hover:bg-brand-soft/40"
                >
                  <span className="shrink-0" style={{ color: PASTEL[(i + 2) % PASTEL.length] }}>
                    {a.icon}
                  </span>
                  <span className="truncate font-medium">{a.label}</span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

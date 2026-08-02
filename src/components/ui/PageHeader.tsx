import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

export interface PageHeaderProps {
  /** Optional leading glyph, shown in a tinted brand chip. */
  icon?: ReactNode;
  /** A one-to-two word contextual tag above the title (e.g. 分区 / 模块). */
  eyebrow?: string;
  /** The page title. Uses the display scale so pages feel distinct. */
  title: string;
  /** One-sentence supporting copy; keep it short. */
  description?: string;
  /** Trailing actions (buttons etc.). Rendered on the baseline on ≥md. */
  children?: ReactNode;
  className?: string;
}

/**
 * PageHeader — the single header block every content page renders.
 *
 * Standardising the page header is the cheapest, highest-leverage move for a
 * coherent feel: it fixes the eyebrow/icon, the title size, the sub-copy and
 * the trailing action slot in ONE place, so every page reads as part of the
 * same product instead of each page re-inventing its own header markup.
 *
 * Pattern:
 *   <PageHeader icon={Sparkles} eyebrow="AI 整理" title="标签整理工作台"
 *               description="一句话说明">
 *     <Button>…trailing actions…</Button>
 *   </PageHeader>
 *
 * On small screens the trailing action drops below the title so the header
 * never overflows; on larger screens it sits on the same baseline.
 */
export function PageHeader({
  icon,
  eyebrow,
  title,
  description,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cx('flex flex-col gap-4 md:flex-row md:items-end md:justify-between', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-brand-ink">
            {icon && <span className="shrink-0">{icon}</span>}
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm leading-relaxed text-ink-soft">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}

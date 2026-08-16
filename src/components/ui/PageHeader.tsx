import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Reveal } from '@/components/atelier';

export interface PageHeaderProps {
  /** Optional leading glyph, shown inline with the eyebrow (Lucide only). */
  icon?: ReactNode;
  /** A one-to-two word contextual tag above the title (e.g. 分区 / 模块). */
  eyebrow?: string;
  /** The page title. Rendered in the fluid atelier display scale. */
  title: string;
  /** One-sentence supporting copy; keep it short. */
  description?: string;
  /** Optional editorial section index, e.g. "02 / 09". Rendered mono, top-right. */
  index?: string;
  /** Trailing actions (buttons etc.). Rendered on the baseline on ≥md. */
  children?: ReactNode;
  className?: string;
}

/**
 * PageHeader — the single header block every content page renders.
 *
 * Atelier edition: the title now uses the fluid display scale
 * (`atelier-display--3`), the eyebrow is a mono letter-spaced label with a
 * leading accent dash, a hairline rule draws itself beneath the block, and
 * the whole header enters with the physics reveal. Every page reads as one
 * editorial system instead of re-inventing its own header markup.
 *
 * Pattern:
 *   <PageHeader icon={<Sparkles size={14} />} eyebrow="AI 整理" index="04 / 09"
 *               title="标签整理工作台" description="一句话说明">
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
  index,
  children,
  className,
}: PageHeaderProps) {
  return (
    <Reveal as="header" className={cx('relative', className)}>
      {index && (
        <span aria-hidden className="atelier-index absolute -top-1 right-0 hidden sm:block">
          {index}
        </span>
      )}
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className="atelier-eyebrow mb-3">
              {icon && <span className="shrink-0">{icon}</span>}
              {eyebrow}
            </p>
          )}
          <h1 className="atelier-display atelier-display--3 text-ink">{title}</h1>
          {description && (
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-soft">{description}</p>
          )}
        </div>
        {children && <div className="flex flex-wrap shrink-0 items-center gap-2">{children}</div>}
      </div>
      <div aria-hidden className="atelier-rule mt-6" />
    </Reveal>
  );
}

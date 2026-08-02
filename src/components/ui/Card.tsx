import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';

/**
 * Card — the single panel shell used across management views.
 *
 * This is the "backend" sibling of the homepage's stat cards: same warm
 * surface, soft border and quiet shadow, so a settings section, a tags list
 * or a tab-group pane reads as part of the same product as the dashboard.
 *
 * Visual notes (from the design system):
 *   - rounded-lg + border-line + bg-surface → matches homepage hero/stat cards
 *   - `interactive` adds the homepage-style hover lift (translateY + shadow)
 *     reserved for genuinely clickable cards — never for static panels.
 */
export function Card({
  children,
  className,
  interactive = false,
  ...rest
}: {
  children: ReactNode;
  interactive?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        'rounded-xl border border-line bg-surface',
        interactive &&
          'card-interactive cursor-pointer',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * CardHeader — the consistent top strip of a management card: optional title,
 * an optional right-aligned action slot and a divider. Keeps section headers
 * from drifting across features.
 */
export function CardHeader({
  title,
  hint,
  action,
  className,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cx(
        'flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0">
        {title && <h3 className="text-sm font-semibold text-ink">{title}</h3>}
        {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}

/**
 * CardBody — padded content area under a CardHeader. Consistent rhythm keeps
 * every form/list aligned to the same 16px padding edge as the homepage.
 */
export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx('px-4 py-4', className)}>{children}</div>;
}

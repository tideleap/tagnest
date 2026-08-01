import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx } from '@/lib/cx';
import { TAG_COLOR_COUNT } from '@shared/types';

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */

export type BadgeTone = 'neutral' | 'brand' | 'positive' | 'caution' | 'critical';

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-sunken text-ink-soft',
  brand: 'bg-brand-soft text-brand-ink',
  positive: 'bg-positive-soft text-positive-ink',
  caution: 'bg-caution-soft text-caution-ink',
  critical: 'bg-critical-soft text-critical-ink',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium',
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * TagChip
 * ------------------------------------------------------------------ */

/**
 * Eight fixed hues. A fixed palette keeps a wall of tags legible; letting
 * users pick arbitrary colours reliably produces mud.
 */
const TAG_HUES = [62, 145, 205, 262, 320, 18, 95, 240];

export function tagColorVars(colorIndex: number) {
  const hue = TAG_HUES[((colorIndex % TAG_COLOR_COUNT) + TAG_COLOR_COUNT) % TAG_COLOR_COUNT];
  return {
    '--tag-bg': `oklch(0.955 0.035 ${hue})`,
    '--tag-fg': `oklch(0.44 0.12 ${hue})`,
    '--tag-dot': `oklch(0.63 0.15 ${hue})`,
  } as React.CSSProperties;
}

export interface TagChipProps {
  name: string;
  colorIndex?: number;
  count?: number;
  size?: 'sm' | 'md';
  onClick?: () => void;
  onRemove?: () => void;
  active?: boolean;
  className?: string;
}

export function TagChip({
  name,
  colorIndex = 0,
  count,
  size = 'md',
  onClick,
  onRemove,
  active,
  className,
}: TagChipProps) {
  const interactive = Boolean(onClick);
  const Wrapper = interactive ? 'button' : 'span';

  return (
    <Wrapper
      {...(interactive ? { type: 'button' as const, onClick } : {})}
      style={tagColorVars(colorIndex)}
      aria-pressed={interactive ? active : undefined}
      className={cx(
        'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full font-medium transition-colors',
        size === 'sm' ? 'h-5.5 px-2 text-2xs' : 'h-6.5 px-2.5 text-xs',
        'bg-[var(--tag-bg)] text-[var(--tag-fg)]',
        'dark:bg-[color-mix(in_oklab,var(--tag-dot)_22%,transparent)] dark:text-[color-mix(in_oklab,var(--tag-dot)_88%,white)]',
        interactive && 'cursor-pointer hover:brightness-97 dark:hover:brightness-125',
        active && 'ring-2 ring-[var(--tag-dot)] ring-offset-1 ring-offset-canvas',
        className,
      )}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--tag-dot)]" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
      {count !== undefined && <span className="shrink-0 opacity-65 tabular-nums">{count}</span>}
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          aria-label={`移除标签 ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }
          }}
          className="-mr-1 flex shrink-0 cursor-pointer rounded-full p-0.5 opacity-60 hover:opacity-100"
        >
          <X size={11} />
        </span>
      )}
    </Wrapper>
  );
}

/* ------------------------------------------------------------------ *
 * Avatar
 * ------------------------------------------------------------------ */

const AVATAR_SIZE = { sm: 'h-6 w-6 text-2xs', md: 'h-8 w-8 text-xs', lg: 'h-11 w-11 text-sm' };

export function Avatar({
  name,
  src,
  size = 'md',
}: {
  name: string;
  src?: string | null;
  size?: keyof typeof AVATAR_SIZE;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <span
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-brand-soft font-semibold text-brand-ink',
        AVATAR_SIZE[size],
      )}
    >
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : initial}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Kbd
 * ------------------------------------------------------------------ */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line bg-sunken px-1.5 font-sans text-2xs font-medium text-ink-faint">
      {children}
    </kbd>
  );
}

/* ------------------------------------------------------------------ *
 * Spinner / Skeleton
 * ------------------------------------------------------------------ */

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span role="status" aria-label={label ?? '加载中'} className="inline-flex">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="anim-spin">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('anim-pulse rounded-sm bg-sunken', className)} aria-hidden />;
}

/* ------------------------------------------------------------------ *
 * EmptyState
 * ------------------------------------------------------------------ */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, compact }: EmptyStateProps) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-16',
      )}
    >
      {icon && (
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sunken text-ink-faint">
          {icon}
        </span>
      )}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description && (
        <p className="max-w-sm text-sm leading-relaxed text-ink-soft">{description}</p>
      )}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * SegmentedControl
 * ------------------------------------------------------------------ */

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  segments,
  label,
  size = 'md',
}: {
  value: T;
  onChange: (next: T) => void;
  segments: Segment<T>[];
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        'inline-flex shrink-0 items-center gap-0.5 rounded-md bg-sunken p-0.5',
        size === 'sm' ? 'h-7.5' : 'h-9',
      )}
    >
      {segments.map((seg) => {
        const selected = seg.value === value;
        return (
          <button
            key={seg.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(seg.value)}
            title={seg.label}
            className={cx(
              'inline-flex h-full items-center gap-1.5 rounded-sm font-medium transition-colors',
              size === 'sm' ? 'px-2 text-2xs' : 'px-3 text-xs',
              selected
                ? 'bg-surface text-ink shadow-raised'
                : 'text-ink-faint hover:text-ink-soft',
            )}
          >
            {seg.icon}
            <span className={cx(seg.icon && 'hidden sm:inline')}>{seg.label}</span>
          </button>
        );
      })}
    </div>
  );
}

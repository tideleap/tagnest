import type { CSSProperties, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { useInView } from '@/hooks/useInView';

/**
 * Reveal — a thin scroll-into-view wrapper used to sprinkle entrance reveals
 * across the dashboard without re-writing the hook at every call site.
 *
 * Renders a plain <div> that fades + lifts in once (IntersectionObserver via
 * useInView, one-shot). `delay` applies a stagger so groups of cards cascade
 * rather than all snapping at once; the cap is kept small (≤ 300ms) so the
 * whole block settles quickly.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  style,
}: {
  children: ReactNode;
  /** Stagger delay in ms (0–300 recommended; 50ms steps for cascades). */
  delay?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={cx('reveal-card', inView && 'is-inview', className)}
      style={{ transitionDelay: `${delay}ms`, ...style }}
    >
      {children}
    </div>
  );
}

/**
 * DecorBlob — a soft, saturated cartoon blob placed behind content to fill
 * "empty" corners and give the page warmth and depth. Pure decoration.
 */
export function DecorBlob({
  className,
  color = '#ffd43b',
  style,
}: {
  className?: string;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={cx('pointer-events-none absolute block rounded-full blur-xl', className)}
      style={{ backgroundColor: color, opacity: 0.55, ...style }}
    />
  );
}

/**
 * Scribble — a short hand-drawn wavy underline used to accent a headline word
 * with a playful, hand-lettered energy. Original SVG path, not from any icon set.
 */
export function Scribble({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cx('pointer-events-none absolute -bottom-2 left-0', className)}>
      <svg viewBox="0 0 120 12" width="120" height="12" fill="none">
        <path
          d="M2 9c16-6 34-6 50-2s34 2 50-2 15-4 16-1"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** Soft dot grid texture for filling background space without screaming. */
export function DottedBg({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('pointer-events-none absolute inset-0', className)}
      style={{
        backgroundImage: 'radial-gradient(currentColor 1.2px, transparent 1.2px)',
        backgroundSize: '22px 22px',
        opacity: 0.12,
      }}
    />
  );
}

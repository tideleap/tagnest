import type { CSSProperties, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/usePrefersReducedMotion';

/**
 * KineticText — an infinite horizontal marquee, used for editorial dividers and
 * section labels. Content is duplicated so the loop is seamless. Hovering pauses
 * it (CSS). Pass `reverse` to run the other way and `duration` for speed.
 */
export function KineticText({
  children,
  reverse = false,
  duration = 26,
  className,
  separator,
}: {
  children: ReactNode;
  reverse?: boolean;
  /** seconds for one full loop. */
  duration?: number;
  className?: string;
  /** optional Lucide icon rendered between repeats. */
  separator?: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  // Honour reduced-motion: pause the marquee so KineticText reads as a static
  // label instead of scrolling (acceptance A-05). Both track copies share the
  // style, so they pause together.
  const trackStyle = { '--marquee-dur': `${duration}s`, animationPlayState: reduced ? 'paused' : undefined } as CSSProperties;
  const track = (
    <div className="marquee__track" style={trackStyle}>
      {children}
      {separator}
    </div>
  );
  return (
    <div
      className={cx('marquee', reverse && 'marquee--reverse', className)}
      aria-hidden={false}
    >
      {track}
      {/* Second copy for a seamless wrap. */}
      <div className="marquee__track" style={trackStyle} aria-hidden>
        {children}
        {separator}
      </div>
    </div>
  );
}

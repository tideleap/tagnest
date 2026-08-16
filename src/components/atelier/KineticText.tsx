import type { CSSProperties, ReactNode } from 'react';
import { cx } from '@/lib/cx';

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
  const trackStyle = { '--marquee-dur': `${duration}s` } as CSSProperties;
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

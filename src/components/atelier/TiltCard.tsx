import { useRef, type ElementType, type ReactNode } from 'react';
import { cx } from '@/lib/cx';

/**
 * TiltCard — a 3D tilt that follows the pointer, with a soft glare that tracks
 * the same position. Pure transform/opacity, so it stays on the compositor.
 * `max` controls the tilt magnitude in degrees. Reduced-motion renders flat.
 */
export function TiltCard({
  as: Tag = 'div',
  max = 9,
  glare = true,
  className,
  children,
}: {
  as?: ElementType;
  max?: number;
  glare?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);

  const onMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    const rx = (0.5 - py) * max * 2;
    const ry = (px - 0.5) * max * 2;
    el.style.setProperty('--tilt-x', `${rx.toFixed(2)}deg`);
    el.style.setProperty('--tilt-y', `${ry.toFixed(2)}deg`);
    el.style.setProperty('--glare-x', `${(px * 100).toFixed(1)}%`);
    el.style.setProperty('--glare-y', `${(py * 100).toFixed(1)}%`);
  };
  const onLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--tilt-x', '0deg');
    el.style.setProperty('--tilt-y', '0deg');
  };

  return (
    <Tag ref={ref} className={cx('tilt', className)} onPointerMove={onMove} onPointerLeave={onLeave}>
      <div className="tilt__inner h-full">{children}</div>
      {glare && <span className="tilt__glare" aria-hidden />}
    </Tag>
  );
}

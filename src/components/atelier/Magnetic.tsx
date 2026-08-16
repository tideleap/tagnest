import { useRef, type ElementType, type ReactNode } from 'react';
import { cx } from '@/lib/cx';

/**
 * Magnetic — wraps any element and nudges it toward the pointer while hovered,
 * springing back on leave. Transform-only (compositor-friendly). Disabled under
 * reduced-motion (renders plain).
 */
export function Magnetic({
  as: Tag = 'div',
  strength = 0.35,
  className,
  children,
}: {
  as?: ElementType;
  /** 0–1, how far the element travels toward the cursor. */
  strength?: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);

  const onMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) * strength;
    const y = (e.clientY - (r.top + r.height / 2)) * strength;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  const onLeave = () => {
    if (ref.current) ref.current.style.transform = 'translate3d(0,0,0)';
  };

  return (
    <Tag
      ref={ref}
      className={cx('magnetic', className)}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      {children}
    </Tag>
  );
}

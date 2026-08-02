import { useEffect, useRef } from 'react';

/**
 * AmbientGlow — a soft brand-coloured light that drifts toward the cursor.
 *
 * A single blurred radial patch translated with `translate3d` on
 * requestAnimationFrame. Being an element transform it stays on the
 * compositor (no layout/paint thrash), and it is:
 *   - pointer-events:none, so it never blocks interaction
 *   - hidden on coarse pointers (touch) and under reduced motion, where a
 *     cursor-following light would be distracting or pointless
 *
 * This is the restrained, perf-safe take on "背景粒子跟随鼠标": one glow,
 * eased, not a particle field.
 */
export function AmbientGlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Skip on touch-only devices and for users who prefer reduced motion.
    const fine = window.matchMedia('(pointer: fine)').matches;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!fine || reduced) return;

    const scale = Math.min(window.innerWidth / 1400, 1.6);
    const target = { x: window.innerWidth * 0.6, y: 0 };
    const current = { ...target };
    let raf = 0;
    let active = false;

    const onMove = (e: PointerEvent) => {
      target.x = e.clientX;
      target.y = e.clientY;
      active = true;
      if (!raf) tick();
    };
    const onLeave = () => {
      active = false;
      // Ease the glow back to a calm corner after the pointer leaves.
      target.x = window.innerWidth * 0.5;
      target.y = window.innerHeight * 0.1;
    };
    const tick = () => {
      raf = 0;
      // Exponential easing toward the target; never snaps.
      current.x += (target.x - current.x) * 0.12;
      current.y += (target.y - current.y) * 0.12;
      el.style.transform = `translate3d(${current.x - 160 * scale}px, ${current.y - 160 * scale}px, 0)`;
      if (active) raf = requestAnimationFrame(tick);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    // Give it a starting position without waiting for a first move.
    el.style.transform = `translate3d(${target.x - 160 * scale}px, ${target.y - 160 * scale}px, 0)`;

    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-0 hidden md:block"
      style={{
        width: 320,
        height: 320,
        borderRadius: '50%',
        background:
          'radial-gradient(circle, color-mix(in oklab, var(--color-brand-soft) 55%, transparent), transparent 70%)',
        opacity: 0.5,
        willChange: 'transform',
      }}
    />
  );
}

// usePrefersReducedMotion — shared hook for respecting the OS
// "reduce motion" setting (A-05 in the UI Design System audit).
//
// CSS `@media (prefers-reduced-motion: reduce)` only covers CSS-driven
// animation/transition. Several components drive motion in JS (magnetic
// hover, tilt, scramble text, cursor-following glow, marquee). Those must
// read the same media query and short-circuit their effects, otherwise the
// preference is silently ignored for the most distracting animations.
//
// Usage:
//   const reduced = usePrefersReducedMotion();
//   if (reduced) return; // skip the JS-driven motion setup

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Returns `true` when the user has requested reduced motion at the OS level.
 * SSR-safe: defaults to `false` when `window` is unavailable.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export default usePrefersReducedMotion;

import { useEffect, useRef, useState } from 'react';

/**
 * useInView — one-shot "scroll into view" detector.
 *
 * Used for touch-of-life reveal-on-scroll. Correctly uses an IntersectionObserver
 * (not a scroll listener) and *unobserves after the first hit*, so a page does
 * not keep paying an observer tax after every element has revealed once. This
 * keeps the cartoon dashboard's reveals cheap on long screens.
 *
 * Returns a ref to attach to the element and a boolean that flips true (and
 * stays true) once the element has entered the viewport.
 *
 * Respects prefers-reduced-motion: if the user prefers reduced motion we return
 * `true` immediately and never observe, so elements render without waiting for
 * a reveal animation.
 */
/**
 * Use InView result. `ref` is exposed as a React-compatible ref object: in
 * React 18 the JSX `ref` prop expects a `Ref<T>` (or a legacy string/callback),
 * and a `RefObject<T | null>` is not directly assignable to it, so we surface
 * `Ref<T>` here and let consumers spread it onto an element directly.
 */
export interface InViewRef<T extends HTMLElement = HTMLDivElement> {
  /** read-only handle; assign to `ref` on any element. */
  ref: React.Ref<T>;
  inView: boolean;
}

export function useInView<T extends HTMLElement = HTMLDivElement>(
  options?: { rootMargin?: string; threshold?: number },
): InViewRef<T> {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Offer the same content with zero delay to users who prefer no motion.
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setInView(true);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true); // very old env — just show it
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.unobserve(entry.target); // one-shot
          }
        }
      },
      { rootMargin: options?.rootMargin ?? '0px 0px -10% 0px', threshold: options?.threshold ?? 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [options?.rootMargin, options?.threshold]);

  // The JSX `ref` prop is typed more loosely than our internal ref object;
  // exposing it as `React.Ref<T>` keeps every consumer's `<div ref={…}>` happy
  // without widening the internal implementation.
  return { ref: ref as React.Ref<T>, inView };
}

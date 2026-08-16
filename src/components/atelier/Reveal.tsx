import {
  Children,
  cloneElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from '@/lib/cx';

type Variant = 'up' | 'blur' | 'scale' | 'rotate';

function useInViewOnce() {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, visible };
}

/**
 * Reveal — scroll/physics entrance wrapper. One-shot IntersectionObserver adds
 * `.is-visible`; atelier.css does the spring transition. `delay` staggers.
 */
export function Reveal({
  as: Tag = 'div',
  variant = 'up',
  delay = 0,
  className,
  children,
}: {
  as?: ElementType;
  variant?: Variant;
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  const { ref, visible } = useInViewOnce();
  return (
    <Tag
      ref={ref as never}
      className={cx(`reveal reveal--${variant}`, visible && 'is-visible', className)}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}

/**
 * Stagger — cascades its *direct children* into view, each offset by `--rv-i`
 * (70ms steps, defined in atelier.css). Children are cloned to receive the index.
 */
export function Stagger({
  as: Tag = 'div',
  className,
  children,
}: {
  as?: ElementType;
  className?: string;
  children: ReactNode;
}) {
  const { ref, visible } = useInViewOnce();
  const items = Children.toArray(children).filter(Boolean) as ReactElement[];
  return (
    <Tag ref={ref as never} className={cx('reveal-stagger', visible && 'is-visible', className)}>
      {items.map((child, i) =>
        cloneElement(child, {
          style: { ...(child.props.style ?? {}), '--rv-i': i } as CSSProperties,
        }),
      )}
    </Tag>
  );
}

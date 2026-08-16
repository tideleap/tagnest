import { useEffect, useRef, useState, type ElementType } from 'react';
import { cx } from '@/lib/cx';

const GLYPHS = 'アイウエオカキクケコ0123456789#%&*$/\\<>[]{}—+=§∆◊';

/**
 * ScrambleText — a "decode" headline effect. Characters scramble through random
 * glyphs and lock left-to-right into the final string, giving hero titles a
 * cyber-editorial reveal. Falls back to plain text under reduced-motion.
 */
export function ScrambleText({
  as: Tag = 'span',
  text,
  className,
  duration = 900,
  delay = 0,
}: {
  as?: ElementType;
  text: string;
  className?: string;
  /** total reveal time in ms. */
  duration?: number;
  delay?: number;
}) {
  const [out, setOut] = useState(text);
  const frame = useRef(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setOut(text);
      return;
    }
    const total = Math.max(300, duration);
    const stepMs = 28;
    const steps = Math.ceil(total / stepMs);
    let timer: number;

    const start = () => {
      frame.current = 0;
      timer = window.setInterval(() => {
        frame.current += 1;
        const revealed = Math.floor((frame.current / steps) * text.length);
        const next = text
          .split('')
          .map((ch, i) => {
            if (ch === ' ') return ' ';
            if (i < revealed) return ch;
            return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          })
          .join('');
        setOut(next);
        if (frame.current >= steps) {
          setOut(text);
          window.clearInterval(timer);
        }
      }, stepMs);
    };

    const d = window.setTimeout(start, delay);
    return () => {
      window.clearTimeout(d);
      window.clearInterval(timer);
    };
  }, [text, duration, delay]);

  return <Tag className={cx('scramble', className)}>{out}</Tag>;
}

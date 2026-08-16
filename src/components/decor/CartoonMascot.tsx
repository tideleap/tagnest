import { useMemo, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { cx } from '@/lib/cx';

/**
 * CartoonMascot — the tiny "Nesty" bookmark mascot that lives on the dashboard.
 *
 * A single original SVG character (rounded bookmark body, sleepy eyes, blush,
 * a leaf sprout) drawn for TagNest. It is the playful, memorable point of the
 * home page and doubles as a small easter-egg:
 *
 *   - idles with a gentle float (CSS),
 *   - wiggles on hover (CSS),
 *   - gives a little "pop" + a random quip on click (React state),
 *   - and is draggable — pick it up anywhere and let it drop; it springs back
 *     after a beat (easter egg for the curious).
 *
 * Dragging uses pointer events, deliberately NOT layout-throttling scroll
 * listeners; the transform is applied to `transform` only, so it stays on the
 * compositor thread and does not jank. Motion honours prefers-reduced-motion at
 * the CSS layer (see index.css).
 */
const QUIPS = [
  '呱，这是你的书签喔！',
  '收藏夹又大了一点点～',
  '点我？懂收藏的人才点得到。',
  'Nesty 在看着你的书签。',
  '今天也要好好整理呀！',
  '轻轻一点，世界大一点。',
];

const PASTEL = ['#ff6b81', '#ffa94d', '#ffd43b', '#69db7c', '#66c2ff', '#b197fc'];

export function CartoonMascot({
  className,
  accent = '#ff6b81',
  size = 96,
}: {
  className?: string;
  accent?: string;
  size?: number;
}) {
  const [popKey, setPopKey] = useState(0);
  const [quip, setQuip] = useState<string | null>(null);
  const [drags, setDrags] = useState(0);

  // Spring the ball back a beat after a drag ends (threshold for "a real drag").
  const [dropped, setDropped] = useState(false);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Random accent each mount so the character changes temperature; stays stable
  // for the session (no flash on every render).
  const tint = useMemo(() => PASTEL[Math.floor(Math.random() * PASTEL.length)], []);

  const handleClick = () => {
    setPopKey((k) => k + 1);
    // Rotating quips add freshness without being predictable.
    setQuip(QUIPS[Math.floor(Math.random() * QUIPS.length)]);
    window.setTimeout(() => setQuip(null), 2200);
  };

  // Pointer-drag handling. We keep it minimal and pointer-based.
  const handlePointerMove = (e: ReactPointerEvent) => {
    const target = e.currentTarget as HTMLElement;
    if (!target.hasPointerCapture(e.pointerId)) return;
    const r = target.getBoundingClientRect();
    // Clamp so the mascot can't be flung fully off-screen.
    const nx = Math.max(-r.width / 2, Math.min(window.innerWidth - r.width / 2, e.clientX - r.width / 2));
    const ny = Math.max(0, Math.min(window.innerHeight - r.height, e.clientY - r.height / 2));
    setOffset({ x: nx, y: ny });
    if (Math.abs(nx) > 4 || Math.abs(ny) > 4) setDrags((d) => d + 1);
  };

  const handlePointerUp = (e: ReactPointerEvent) => {
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
    // Snap back home after a pleasantly short beat.
    if (Math.abs(offset.x) > 2 || Math.abs(offset.y) > 2) {
      setDropped(true);
      window.setTimeout(() => {
        setOffset({ x: 0, y: 0 });
        setDropped(false);
      }, 2500);
    }
  };

  const style: CSSProperties = {
    width: size,
    height: size,
    transform: `translate(${offset.x}px, ${offset.y}px)`,
  };

  return (
    <span className={cx('inline-block select-none', className)} style={style}>
      {/* Pop animation keyed per click so it retriggers. */}
      <span
        key={popKey}
        role="img"
        aria-label="书签小精灵 Nesty，可拖拽、可点击"
        title="书签小精灵 Nesty"
        className={cx(
          'mascot-idle inline-block cursor-grab active:cursor-grabbing',
          'mascot-pop',
          drags > 0 && 'mascot-looong',
        )}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={handleClick}
      >
        <svg viewBox="0 0 96 96" width={size} height={size} aria-hidden className="mascot-wiggle">
          {/* soft ground shadow */}
          <ellipse cx="48" cy="88" rx="22" ry="5" fill="rgba(0,0,0,0.10)" />
          {/* bookmark body */}
          <path
            d="M20 18a6 6 0 0 1 6-6h44a6 6 0 0 1 6 6v58a4 4 0 0 1-6.3 3.2L48 62l-21.7 17.2A4 4 0 0 1 20 76Z"
            fill={tint}
          />
          {/* spine highlight */}
          <path
            d="M28 20h10v44l-10 8Z"
            fill="rgba(255,255,255,0.30)"
          />
          {/* eyes */}
          <circle cx="37" cy="42" r="5" fill="#4a3b32" />
          <circle cx="37" cy="40.5" r="1.6" fill="#fff" />
          <circle cx="59" cy="42" r="5" fill="#4a3b32" />
          <circle cx="59" cy="40.5" r="1.6" fill="#fff" />
          {/* blush */}
          <ellipse cx="28" cy="52" rx="5.5" ry="3.2" fill="rgba(255,255,255,0.55)" />
          <ellipse cx="68" cy="52" rx="5.5" ry="3.2" fill="rgba(255,255,255,0.55)" />
          {/* tab dot */}
          <rect x="44" y="26" width="8" height="8" rx="2.5" fill="#fff" opacity="0.85" />
          {/* leaf sprout (organic touch) */}
          <path
            d="M49 18c0-6 5-10 11-10 0 6-5 10-11 10Z"
            fill={accent}
          />
          <path d="M49 18c2 3 5 5 8 5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.7" />
        </svg>
        {/* spring-home fly-back indicator */}
        {dropped && (
          <span className="absolute inset-x-0 -top-3 text-center text-2xs font-medium text-ink-soft">
            回弹～
          </span>
        )}
      </span>

      {/* random quip bubble */}
      {quip && (
        <span
          className="mascot-quip absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-surface px-3 py-1.5 text-xs text-ink shadow-overlay"
          role="status"
        >
          {quip}
        </span>
      )}
    </span>
  );
}

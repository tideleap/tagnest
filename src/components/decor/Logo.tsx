import { cx } from '@/lib/cx';

/**
 * Logo — the single, shared brand mark for TagNest.
 *
 * Previously the bookmark glyph was inlined in three places with subtly
 * different sizes/radii. Centralising it means the sidebar rail and the auth
 * page promote the *same* mark, so the brand reads consistently and the glyph
 * can be enlarged here once.
 *
 * The mark is a brand-gradient rounded tile with a crisp bookmark outline and
 * a soft ambient halo. It intentionally scales up to be the page's visual
 * anchor (this is the "放大 favicon / logo" ask) while staying sharp — the
 * glyph is an inline vector, so any size keeps crisp edges.
 *
 * `size` drives the tile; the glyph is always a fixed proportion inside it.
 */

interface LogoProps {
  /** Tile edge length in px. Default 40. */
  size?: number;
  /** Replaces the solid brand fill with a muted "quiet" surface (e.g. dark app shells). */
  subtle?: boolean;
  className?: string;
}

const GLYPH_PATH =
  'M7 4h10a1 1 0 0 1 1 1v14.4a.7.7 0 0 1-1.1.57L12 16.6l-4.9 3.37A.7.7 0 0 1 6 19.4V5a1 1 0 0 1 1-1Z';

export function Logo({ size = 40, subtle = false, className }: LogoProps) {
  const glyph = Math.round(size * 0.52);
  const radius = size >= 48 ? 14 : size >= 40 ? 12 : 10;
  return (
    <span
      aria-hidden
      className={cx(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden',
        !subtle && 'brand-grad shadow-glow',
        subtle && 'bg-brand-soft text-brand-ink',
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        color: subtle ? undefined : 'var(--color-on-brand)',
      }}
    >
      {/* sheen — a soft diagonal highlight so the tile reads dimensional, not flat */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(150deg, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0) 40%), linear-gradient(20deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0) 45%)',
        }}
      />
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        className="relative"
      >
        <path d={GLYPH_PATH} fill="currentColor" />
      </svg>
    </span>
  );
}

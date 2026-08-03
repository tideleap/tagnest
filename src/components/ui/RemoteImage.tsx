import { useEffect, useState } from 'react';
import type { ImgHTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';

export interface RemoteImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'onError'> {
  src: string;
  alt?: string;
  /** Rendered in place of the <img> once the source fails to load. */
  fallback?: ReactNode;
}

/**
 * A single reliable path for rendering an image fetched from an arbitrary
 * remote origin (favicons, cover thumbnails, share previews).
 *
 * Concerns it owns so callers don't each re-implement them:
 *  - deferred loading (`loading="lazy"`, `decoding="async"`)
 *  - a graceful error fallback instead of a broken-image icon
 *  - reserving layout space so rows don't jump (callers supply size / ratio)
 *
 * Use it for bookmarks the user added; we keep a plain <img> for tightly
 * controlled first-party assets.
 */
export function RemoteImage({ src, alt = '', fallback, className, style, ...rest }: RemoteImageProps) {
  const [failed, setFailed] = useState(false);

  // A previously-failed src must not poison a NEW src on the same instance —
  // e.g. a bookmark whose snapshot/cover loads after an earlier placeholder
  // failed. Reset the failure flag whenever the source changes.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed && fallback) return <>{fallback}</>;

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cx('select-none', className)}
      style={style}
      {...rest}
    />
  );
}

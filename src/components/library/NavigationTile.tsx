import { memo } from 'react';
import { ExternalLink, Star } from 'lucide-react';
import type { Bookmark } from '@shared/types';
import { cx } from '@/lib/cx';
import { displayHost, faviconFor } from '@/lib/url';
import { RemoteImage } from '@/components/ui';
import { useRecordVisit, useToggleFavorite } from '@/hooks/queries';

/**
 * NavigationTile — the compact "site navigation" cell used inside the
 * CategoryView browse grid. Unlike BookmarkCard it is built for fast visual
 * scanning and one-click open: a large favicon, the site name, and the host,
 * with only a lightweight favourite toggle surfaced on hover. No snapshots,
 * descriptions, tag lists, or management menus — those belong to the list /
 * grid management views.
 */
function NavFavicon({ bookmark, size }: { bookmark: Bookmark; size: number }) {
  const src = bookmark.faviconUrl ?? faviconFor(bookmark.url);
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sunken"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <RemoteImage
        src={src}
        alt=""
        width={size * 0.62}
        height={size * 0.62}
        className="object-contain"
        fallback={
          <span className="flex h-full w-full items-center justify-center text-sm font-bold uppercase text-brand-ink">
            {displayHost(bookmark.url).charAt(0)}
          </span>
        }
      />
    </span>
  );
}

export const NavigationTile = memo(function NavigationTile({ bookmark: b }: { bookmark: Bookmark }) {
  const recordVisit = useRecordVisit();
  const toggleFavorite = useToggleFavorite();

  const title = b.title || displayHost(b.url);
  const host = displayHost(b.url);

  return (
    <a
      href={b.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        // Let modifier / middle clicks open natively; plain left click records
        // the visit and opens via JS so we control the timing.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        recordVisit.mutate(b.id);
        window.open(b.url, '_blank', 'noopener,noreferrer');
      }}
      title={title}
      className={cx(
        'group relative flex h-full flex-col gap-2 rounded-xl border border-line bg-surface p-3',
        'transition-all duration-150 hover:-translate-y-0.5 hover:border-brand hover:shadow-float',
      )}
    >
      <div className="flex items-start gap-2.5">
        <NavFavicon bookmark={b} size={36} />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="line-clamp-2 text-sm font-medium leading-snug text-ink">{title}</p>
          <p className="mt-0.5 truncate text-2xs text-ink-faint">{host}</p>
        </div>
      </div>

      <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          aria-label={b.isFavorite ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleFavorite.mutate({ id: b.id, isFavorite: !b.isFavorite });
          }}
          className={cx(
            'flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-sunken hover:text-ink',
            b.isFavorite && 'text-caution',
          )}
        >
          <Star size={13} className={b.isFavorite ? 'fill-caution' : ''} aria-hidden />
        </button>
        <span className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint" aria-hidden>
          <ExternalLink size={13} />
        </span>
      </div>
    </a>
  );
});

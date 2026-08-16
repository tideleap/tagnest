import { memo } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Bookmark } from '@shared/types';
import { cx } from '@/lib/cx';
import { displayHost, faviconFor } from '@/lib/url';
import { RemoteImage, Skeleton, TagChip } from '@/components/ui';
import { useSimilarBookmarks } from '@/hooks/queries';
import { useOverlay } from '@/stores/ui';

/**
 * A2 — "related bookmarks" panel for the editor.
 *
 * Ranks bookmarks by tag/domain/text similarity and lets the user jump straight
 * into editing a sibling. Ranked results are deterministic (computed from the
 * saved record at request time), so the list is stable across renders. The
 * source bookmark is excluded server-side, and private bookmarks never enter the
 * candidate pool, so nothing secret leaks across the privacy boundary here.
 */
function SimilarBookmarksBase({ id }: { id: string }) {
  const setEditingBookmarkId = useOverlay((s) => s.setEditingBookmarkId);
  const { data, isLoading, isError } = useSimilarBookmarks(id, 8);

  const items = data?.items ?? [];

  return (
    <section
      aria-label="相关书签"
      className="rounded-md border border-line px-3.5 py-3"
    >
      <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        相关书签
      </p>

      {isLoading ? (
        <ul className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-2.5">
              <Skeleton className="h-7 w-7 rounded-md" />
              <div className="flex flex-1 flex-col gap-1">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-2.5 w-1/3" />
              </div>
            </li>
          ))}
        </ul>
      ) : isError ? (
        <p className="text-xs leading-relaxed text-ink-faint">相关书签暂时无法加载。</p>
      ) : items.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-faint">暂时没有足够相似的书签。</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((b: Bookmark) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setEditingBookmarkId(b.id)}
                className={cx(
                  'group flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left',
                  'transition-colors hover:bg-surface-hover',
                )}
              >
                <span className="favicon-badge flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md">
                  <RemoteImage
                    src={b.faviconUrl ?? faviconFor(b.url)}
                    alt=""
                    width={16}
                    height={16}
                    className="object-contain"
                    fallback={
                      <span className="flex h-full w-full items-center justify-center text-2xs font-bold uppercase text-brand-ink">
                        {displayHost(b.url).charAt(0)}
                      </span>
                    }
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-ink">
                    {b.title || displayHost(b.url)}
                  </span>
                  <span className="truncate text-2xs text-ink-faint">{displayHost(b.url)}</span>
                  {b.tags.length > 0 && (
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {b.tags.slice(0, 2).map((t) => (
                        <TagChip key={t.id} name={t.name} colorIndex={t.colorIndex} size="sm" />
                      ))}
                      {b.tags.length > 2 && (
                        <span className="text-2xs text-ink-faint">+{b.tags.length - 2}</span>
                      )}
                    </span>
                  )}
                </span>
                <ExternalLink
                  size={13}
                  aria-hidden
                  className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const SimilarBookmarks = memo(SimilarBookmarksBase);

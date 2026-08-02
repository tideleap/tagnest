import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ExternalLink, Link2, Search } from 'lucide-react';
import type { PublicBookmark, PublicShare, SharePalette, ShareTheme } from '@shared/types';
import { Button, EmptyState, Spinner, TagChip } from '@/components/ui';
import { displayHost, faviconFor, relativeTime } from '@/lib/url';
import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';

/** The palettes a share page can render with (subset of the app themes). */
const VALID_PALETTES: SharePalette[] = ['light', 'dark', 'aurora', 'blossom', 'starlight'];

/**
 * Read-only public share page.
 *
 * Renders entirely from the anonymous `/api/public/:slug` endpoint — no auth,
 * no app chrome beyond a minimal header. Theming (default / compact / cards)
 * is stored on the share and applied here, and the color palette is set on
 * <html data-theme> so the page matches the author's chosen look rather than
 * following the viewer's own OS preference.
 */
export function SharePage() {
  const { slug = '' } = useParams();

  const { data, isLoading, isError, error } = useQuery<PublicShare>({
    queryKey: ['public-share', slug],
    queryFn: () => api.get<PublicShare>(`/public/${slug}`),
    retry: false,
  });

  // Jump to top whenever the slug changes — a share page is a destination,
  // not a scroll position to preserve.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [slug]);

  // Apply the share author's chosen palette while this page is visible.
  // Restored to the shell default on unmount / palette change so other routes
  // (e.g. a deep link back into the app) are not left tinted.
  useEffect(() => {
    const palette =
      data && VALID_PALETTES.includes(data.palette) ? data.palette : ('light' as SharePalette);
    const host = document.documentElement;
    const prev = host.dataset.theme;
    host.dataset.theme = palette;
    return () => {
      if (prev) host.dataset.theme = prev;
    };
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-faint">
        <Spinner size={24} />
      </div>
    );
  }

  if (isError || !data) {
    const message =
      (error as { message?: string } | null)?.message ?? '这个分享链接不存在或已失效。';
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <EmptyState
          icon={<Search size={22} />}
          title="找不到这个分享"
          description={message}
          action={
            <Link to="/">
              <Button variant="primary">前往 TagNest</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <header className="mb-6 border-b border-line pb-5">
          <h1 className="text-2xl font-bold text-ink">{data.title}</h1>
          {data.description && (
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{data.description}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-ink-faint">
            <span>由 {data.owner} 分享</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{data.total} 个书签</span>
            {data.tags.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="flex flex-wrap gap-1">
                  {data.tags.map((t) => (
                    <TagChip key={t.name} name={t.name} colorIndex={t.colorIndex} size="sm" />
                  ))}
                </span>
              </>
            )}
          </div>
        </header>

        {data.items.length === 0 ? (
          <EmptyState icon={<Link2 size={22} />} title="还没有书签" description="这个分享页暂时是空的。" />
        ) : (
          <ShareList items={data.items} theme={data.theme} />
        )}

        <footer className="mt-10 border-t border-line pt-4 text-center text-2xs text-ink-faint">
          由 TagNest 强力驱动 ·{' '}
          <Link to="/" className="underline-offset-2 hover:text-ink-soft hover:underline">
            创建你自己的书签库
          </Link>
        </footer>
      </div>
    </div>
  );
}

function ShareList({ items, theme }: { items: PublicBookmark[]; theme: ShareTheme }) {
  if (theme === 'cards') {
    return (
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map((b) => (
          <li key={b.id}>
            <PublicCard bookmark={b} />
          </li>
        ))}
      </ul>
    );
  }

  const compact = theme === 'compact';
  return (
    <ul className="flex flex-col gap-2">
      {items.map((b) => (
        <li key={b.id}>
          <PublicRow bookmark={b} compact={compact} />
        </li>
      ))}
    </ul>
  );
}

function Favicon({ url, size }: { url: string; size: number }) {
  const src = faviconFor(url);
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="shrink-0 rounded-sm bg-sunken object-contain"
      style={{ width: size, height: size }}
    />
  );
}

function PublicRow({ bookmark: b, compact }: { bookmark: PublicBookmark; compact: boolean }) {
  return (
    <a
      href={b.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start gap-3 rounded-md border border-line bg-surface px-3.5 py-3 transition-colors hover:border-line-strong"
    >
      <Favicon url={b.url} size={compact ? 16 : 20} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-medium text-ink group-hover:text-brand-ink">
            {b.title || displayHost(b.url)}
          </h3>
          <ExternalLink size={13} className="shrink-0 text-ink-faint opacity-0 group-hover:opacity-100" aria-hidden />
        </div>
        {!compact && (b.note || b.description) && (
          <p className="line-clamp-2 text-xs leading-relaxed text-ink-soft">
            {b.note || b.description}
          </p>
        )}
        {!compact && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-ink-faint">
            <span className="shrink-0">{displayHost(b.url)}</span>
            <span aria-hidden>·</span>
            <time dateTime={b.createdAt}>{relativeTime(b.createdAt)}</time>
            {b.tags.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {b.tags.map((t) => (
                  <TagChip key={t.name} name={t.name} colorIndex={t.colorIndex} size="sm" />
                ))}
              </span>
            )}
          </div>
        )}
      </div>
    </a>
  );
}

function PublicCard({ bookmark: b }: { bookmark: PublicBookmark }) {
  return (
    <a
      href={b.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex h-full flex-col gap-2 rounded-md border border-line bg-surface p-3.5 transition-colors hover:border-line-strong"
    >
      <div className="flex items-center gap-2">
        <Favicon url={b.url} size={18} />
        <span className="min-w-0 truncate text-2xs text-ink-faint">{displayHost(b.url)}</span>
      </div>
      <h3 className="line-clamp-2 text-sm font-medium text-ink group-hover:text-brand-ink">
        {b.title || displayHost(b.url)}
      </h3>
      {b.note || b.description ? (
        <p className="line-clamp-3 flex-1 text-xs leading-relaxed text-ink-soft">
          {b.note || b.description}
        </p>
      ) : null}
      {b.tags.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1 pt-1">
          {b.tags.map((t) => (
            <TagChip key={t.name} name={t.name} colorIndex={t.colorIndex} size="sm" />
          ))}
        </div>
      )}
    </a>
  );
}

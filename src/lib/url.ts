/** Host without `www.`, for display. Falls back to the raw string. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Google's favicon service.
 *
 * A remote service rather than fetching and storing icons ourselves: it costs
 * no storage, no crawl budget, and degrades to a blank square if it fails.
 */
export function faviconFor(url: string, size = 64): string {
  const host = displayHost(url);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
}

/** Accepts `example.com` and returns a usable absolute URL. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

export function relativeTime(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return '刚刚';

  for (const [unit, secondsPerUnit] of RELATIVE_UNITS) {
    if (seconds >= secondsPerUnit) {
      return rtf.format(-Math.floor(seconds / secondsPerUnit), unit);
    }
  }
  return '刚刚';
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

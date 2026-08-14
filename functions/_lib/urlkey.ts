/**
 * Tracking parameters stripped before computing the duplicate key.
 *
 * Without this, the same article shared from a newsletter, a tweet and a
 * search result produces three "different" bookmarks — the single most common
 * source of duplicate clutter in an imported library.
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'referrer',
  'spm',
  'scm',
  'from',
  'source',
  '_hsenc',
  '_hsmi',
  'igshid',
  'yclid',
  'vero_id',
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Parses loosely typed user input into a canonical absolute URL, or null. */
export function parseUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  // javascript:, data: and file: URLs have no place in a shared bookmark store.
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;

  return url;
}

/**
 * Duplicate-detection key. Deliberately lossy — it is never displayed and
 * never navigated to, only compared.
 */
export function urlKey(input: string): string {
  const url = parseUrl(input);
  if (!url) return input.trim().toLowerCase();

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    params.append(key, value);
  }
  params.sort(); // Parameter order is not semantically meaningful.

  const query = params.toString();
  const path = url.pathname.replace(/\/+$/, '');

  // Scheme is excluded on purpose: http:// and https:// of the same page are
  // the same bookmark as far as a human is concerned.
  return `${host}${path}${query ? `?${query}` : ''}`;
}

/** Normalises for storage: keeps everything meaningful, drops only the hash noise. */
export function canonicalUrl(input: string): string | null {
  const url = parseUrl(input);
  if (!url) return null;
  // A fragment is a client-side anchor; two bookmarks of the same page that
  // differ only by #section are the same bookmark, so the canonical form
  // drops it. (Duplicate detection via urlKey already ignores fragments.)
  if (url.hash) url.hash = '';
  return url.toString();
}

export function faviconFor(input: string): string | null {
  const url = parseUrl(input);
  if (!url) return null;
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(url.hostname)}`;
}

/** A readable fallback title when the source gave us nothing. */
export function titleFallback(input: string): string {
  const url = parseUrl(input);
  if (!url) return input.slice(0, 120);
  const path = url.pathname.replace(/\/+$/, '');
  const last = path.split('/').filter(Boolean).pop();
  if (!last) return url.hostname.replace(/^www\./, '');
  return decodeURIComponent(last.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ')).slice(
    0,
    200,
  );
}

/**
 * Hostname without a leading `www.`, lower-cased. Returns null for unparseable
 * input. This is the single, shared host-normalisation used by the AI tagger
 * (domain fallback, same-host boost, feedback domain) and any future callers,
 * so the `new URL(...).hostname` logic lives in exactly one place.
 */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

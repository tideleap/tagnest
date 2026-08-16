// TagNest extension — pure bookmark reconciliation helpers (B-12, Phase A).
//
// These helpers run in the extension's own JS context but must NOT touch
// `chrome.*` at module load, so Vitest can import them from the backend test
// suite and assert byte-for-byte parity with the server's `urlKey` in
// functions/_lib/urlkey.ts. All browser-tree reading and network calls live
// in reconcile.js; this file is deterministic and side-effect free.

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

/**
 * Faithful port of functions/_lib/urlkey.ts `parseUrl`. Loose user input is
 * upgraded to https://, javascript:/data:/file: are rejected, and a bare
 * hostname without a dot (other than localhost) is rejected.
 */
function parseUrl(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
  return url;
}

/**
 * Duplicate-detection key — byte-for-byte equivalent to the backend's
 * `urlKey`. Host lower-cased and de-www'd, tracking params stripped, query
 * sorted, trailing slash dropped, scheme ignored. A non-parseable input falls
 * back to its trimmed lower-cased form (matching the server).
 */
export function urlKey(input) {
  const url = parseUrl(input);
  if (!url) return String(input ?? '').trim().toLowerCase();

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    params.append(key, value);
  }
  params.sort();

  const query = params.toString();
  const path = url.pathname.replace(/\/+$/, '');

  return `${host}${path}${query ? `?${query}` : ''}`;
}

/**
 * Flatten a chrome.bookmarks tree into a flat list of URL nodes. Folders
 * (nodes without `.url`) are descended; each leaf carries its id, url, title,
 * parent folder id, and creation time (epoch ms).
 */
export function flattenBrowserBookmarks(nodes) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.url) {
      out.push({
        id: node.id,
        url: node.url,
        title: node.title || '',
        parentId: node.parentId ?? null,
        dateAdded: node.dateAdded ?? null,
      });
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  (Array.isArray(nodes) ? nodes : [nodes]).forEach(walk);
  return out;
}

/**
 * Reconcile the browser's bookmark set against TagNest's key set.
 *
 * @param {Array<{id:string,url:string,title?:string}>} browserList flat list
 *   of browser bookmark leaves (see flattenBrowserBookmarks).
 * @param {Array<{id:string,urlKey:string,title?:string}>} tnList TagNest keys
 *   returned by GET /api/bookmarks/sync-keys.
 * @returns {{ onlyInBrowser:Array, onlyInTagNest:Array, both:Array }}
 *   onlyInBrowser — in the browser but not in TagNest (candidates to push up).
 *   onlyInTagNest — in TagNest but not in the browser (candidates to pull down).
 *   both — present in both (already synced); carries the matched pair.
 */
export function diffByKey(browserList, tnList) {
  const tnByKey = new Map();
  for (const tn of tnList || []) {
    if (tn && tn.urlKey) tnByKey.set(tn.urlKey, tn);
  }

  const onlyInBrowser = [];
  const both = [];
  const seenTnKeys = new Set();

  for (const b of browserList || []) {
    const key = urlKey(b && b.url);
    if (!key) continue;
    const tn = tnByKey.get(key);
    if (tn) {
      both.push({ browser: b, tagNest: tn, urlKey: key });
      seenTnKeys.add(key);
    } else {
      onlyInBrowser.push({ id: b.id, url: b.url, title: b.title || '', urlKey: key });
    }
  }

  const onlyInTagNest = [];
  for (const [key, tn] of tnByKey) {
    if (!seenTnKeys.has(key)) {
      onlyInTagNest.push({ id: tn.id, urlKey: tn.urlKey, title: tn.title || '' });
    }
  }

  return { onlyInBrowser, onlyInTagNest, both };
}

import type { Env, RequestData } from '../_lib/env';
import { requireUserId } from '../_lib/auth';
import { badRequest, json, readJson } from '../_lib/http';
import { faviconFor, parseUrl, titleFallback } from '../_lib/urlkey';

/** Hostnames that must never be fetched on a user's behalf. */
const BLOCKED_HOSTS = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i;

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024;

interface Metadata {
  title: string;
  description: string | null;
  faviconUrl: string | null;
}

/**
 * Best-effort page metadata.
 *
 * This never fails the caller: QuickAdd saves the bookmark first and enriches
 * it afterwards, so a slow or hostile site degrades to a URL-derived title
 * instead of blocking the save.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  requireUserId(ctx);

  const body = await readJson<{ url?: string }>(ctx.request);
  const target = parseUrl(String(body.url ?? ''));
  if (!target) throw badRequest('网址格式不正确', { url: '网址格式不正确' });

  // SSRF guard. The edge cannot reach a customer's LAN, but a redirect into a
  // Cloudflare-internal address is worth refusing outright.
  if (BLOCKED_HOSTS.test(target.hostname)) {
    throw badRequest('不支持抓取该地址');
  }

  const fallback: Metadata = {
    title: titleFallback(target.toString()),
    description: null,
    faviconUrl: faviconFor(target.toString()),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some sites serve a JS shell to unknown agents; a browser-ish UA gets
        // the real <head>.
        'User-Agent':
          'Mozilla/5.0 (compatible; TagNest/1.0; +https://github.com/) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    if (!response.ok || !response.body) return json(fallback);

    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('html')) return json(fallback);

    const parsed = await extract(response, target.toString());
    return json({
      title: parsed.title || fallback.title,
      description: parsed.description,
      faviconUrl: parsed.faviconUrl ?? fallback.faviconUrl,
    } satisfies Metadata);
  } catch {
    // Timeout, DNS failure, TLS error — all the same to the caller.
    return json(fallback);
  } finally {
    clearTimeout(timer);
  }
};

async function extract(response: Response, baseUrl: string): Promise<Metadata> {
  let title = '';
  let description: string | null = null;
  let icon: string | null = null;

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(chunk) {
        if (title.length < 300) title += chunk.text;
      },
    })
    .on('meta', {
      element(el) {
        const key = (el.getAttribute('property') ?? el.getAttribute('name') ?? '').toLowerCase();
        const content = el.getAttribute('content');
        if (!content) return;

        // og:title wins over <title>: it is the author-curated headline,
        // without the " | Site Name" suffix.
        if (key === 'og:title' && content.trim()) title = content.trim();
        if ((key === 'description' || key === 'og:description') && !description) {
          description = content.trim().slice(0, 500);
        }
      },
    })
    .on('link', {
      element(el) {
        const rel = (el.getAttribute('rel') ?? '').toLowerCase();
        if (!rel.includes('icon') || icon) return;
        const href = el.getAttribute('href');
        if (!href) return;
        try {
          icon = new URL(href, baseUrl).toString();
        } catch {
          /* relative href on a malformed base */
        }
      },
    });

  // Cap the read: a multi-megabyte page has nothing useful past the <head>.
  const limited = new Response(response.body, { headers: response.headers });
  const buffer = await limited.arrayBuffer().then((b) => b.slice(0, MAX_BYTES));

  await rewriter.transform(new Response(buffer)).arrayBuffer();

  return {
    title: title.replace(/\s+/g, ' ').trim().slice(0, 300),
    description,
    faviconUrl: icon,
  };
}

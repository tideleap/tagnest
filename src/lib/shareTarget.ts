import { normalizeUrl } from '@/lib/url';

/**
 * Parsed result of a Web Share Target navigation.
 *
 * `url` is null when no usable link could be recovered — the receiving page
 * then shows a manual-entry form instead of failing silently.
 */
export interface ShareTargetDraft {
  url: string | null;
  title: string;
  /** Leftover share text (minus the extracted URL) becomes the note. */
  note: string;
}

/**
 * Extracts the first http(s) URL embedded in free-form share text.
 *
 * Some apps (chat clients, readers) share a blob of text where the link is
 * only part of the payload. We take the first http(s) token and stop at
 * whitespace or common trailing punctuation that chat apps love to append.
 */
export function extractUrlFromText(text: string): string | null {
  const match = /https?:\/\/[^\s"'<>，。；、）】]+/i.exec(text);
  if (!match) return null;
  // Strip trailing punctuation the regex happily swallows ("…链接。").
  const cleaned = match[0].replace(/[),.;:!?。，；：！？]+$/, '');
  return normalizeUrl(cleaned);
}

/**
 * Turns the raw `share_target` query params (url/title/text) into a bookmark
 * draft. Pure function — unit-tested without a DOM.
 *
 * Resolution order for the URL:
 *   1. explicit `url` param (the common case: browser "Share → TagNest")
 *   2. first http(s) link found inside `text` (apps that share plain text)
 *
 * The note keeps whatever text isn't the URL itself, mirroring the browser
 * extension's "selection becomes the note" behaviour.
 */
export function parseShareTarget(params: {
  url?: string | null;
  title?: string | null;
  text?: string | null;
}): ShareTargetDraft {
  const rawUrl = typeof params.url === 'string' ? params.url.trim() : '';
  const title = typeof params.title === 'string' ? params.title.trim() : '';
  const text = typeof params.text === 'string' ? params.text.trim() : '';

  let url = normalizeUrl(rawUrl);
  if (!url && text) {
    url = extractUrlFromText(text);
  }

  // Keep the link out of the note whether it arrived as `url` or was mined
  // out of `text`, and collapse the gap it leaves so the note reads cleanly.
  let note = text;
  if (url && text) {
    note = text
      .replace(/https?:\/\/[^\s"'<>，。；、）】]+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Title fallback: share text without the URL, else empty (the backend's
  // titleFallback derives one from the domain on save).
  const resolvedTitle = title || (url && note ? note.slice(0, 300) : '');

  return { url, title: resolvedTitle, note: url ? note : text };
}

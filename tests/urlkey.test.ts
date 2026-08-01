import { describe, it, expect } from 'vitest';
import { canonicalUrl, urlKey, parseUrl, faviconFor, titleFallback } from '../functions/_lib/urlkey';

describe('parseUrl', () => {
  it('rejects empty input', () => {
    expect(parseUrl('')).toBeNull();
  });

  it('rejects javascript: and data: schemes', () => {
    expect(parseUrl('javascript:alert(1)')).toBeNull();
    expect(parseUrl('data:text/html,hello')).toBeNull();
  });

  it('rejects non-web protocols', () => {
    expect(parseUrl('ftp://ftp.example.com')).toBeNull();
  });

  it('prepends https to bare hosts', () => {
    expect(parseUrl('example.com')?.hostname).toBe('example.com');
    expect(parseUrl('example.com')?.protocol).toBe('https:');
  });

  it('accepts localhost without a dot', () => {
    const u = parseUrl('localhost');
    expect(u?.hostname).toBe('localhost');
  });

  it('keeps an explicit localhost origin', () => {
    const u = parseUrl('http://localhost:3000/admin');
    expect(u?.hostname).toBe('localhost');
    expect(u?.port).toBe('3000');
  });

  it('rejects hosts with no dot and not localhost', () => {
    expect(parseUrl('http://intranet')).toBeNull();
  });
});

describe('canonicalUrl', () => {
  it('returns a normalised https URL unchanged except the hash', () => {
    expect(canonicalUrl('https://example.com/path/')).toBe('https://example.com/path/');
  });

  it('strips the fragment', () => {
    expect(canonicalUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('returns null for unsafe schemes', () => {
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
  });

  it('adds a scheme to a bare host', () => {
    expect(canonicalUrl('example.com/x')).toBe('https://example.com/x');
  });
});

describe('urlKey (duplicate detection)', () => {
  it('strips tracking parameters', () => {
    const a = urlKey('https://example.com/p?utm_source=news&id=5');
    const b = urlKey('https://example.com/p?id=5&utm_medium=email');
    expect(a).toBe(b);
    expect(a).toBe('example.com/p?id=5');
  });

  it('is scheme-agnostic', () => {
    expect(urlKey('http://example.com/a')).toBe(urlKey('https://example.com/a'));
  });

  it('lowercases the host', () => {
    expect(urlKey('https://Example.COM/a')).toBe(urlKey('https://example.com/a'));
  });

  it('drops the leading www and trailing slash', () => {
    expect(urlKey('https://www.example.com/')).toBe('example.com');
  });

  it('sorts query parameters so order does not matter', () => {
    expect(urlKey('https://x.com/?b=2&a=1')).toBe(urlKey('https://x.com/?a=1&b=2'));
  });

  it('treats the same article under different trackers as a duplicate', () => {
    const base = 'https://blog.dev/post-1';
    expect(urlKey(`${base}?utm_source=twitter`)).toBe(urlKey(`${base}?ref=newsletter`));
  });
});

describe('faviconFor', () => {
  it('delegates to Google s2 for the hostname', () => {
    expect(faviconFor('https://github.com/x')).toBe(
      'https://www.google.com/s2/favicons?sz=64&domain=github.com',
    );
  });

  it('returns null for unparseable input', () => {
    expect(faviconFor('not a url')).toBeNull();
  });
});

describe('titleFallback', () => {
  it('derives a readable title from the path', () => {
    expect(titleFallback('https://example.com/some-cool-article')).toBe('some cool article');
  });

  it('falls back to the hostname when there is no path', () => {
    expect(titleFallback('https://example.com')).toBe('example.com');
  });
});

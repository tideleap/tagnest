import { describe, expect, it } from 'vitest';
import { extractUrlFromText, parseShareTarget } from './shareTarget';

describe('extractUrlFromText', () => {
  it('finds a bare link in free-form text', () => {
    expect(extractUrlFromText('看看这个 https://example.com/a 不错')).toBe(
      'https://example.com/a',
    );
  });

  it('strips trailing CJK punctuation chat apps append', () => {
    expect(extractUrlFromText('链接：https://example.com/x。')).toBe('https://example.com/x');
  });

  it('returns null when there is no link', () => {
    expect(extractUrlFromText('一段没有链接的分享文字')).toBeNull();
  });
});

describe('parseShareTarget', () => {
  it('prefers the explicit url param', () => {
    const draft = parseShareTarget({
      url: 'https://example.com/page',
      title: '页面标题',
      text: 'https://example.com/page 一些备注',
    });
    expect(draft.url).toBe('https://example.com/page');
    expect(draft.title).toBe('页面标题');
    // The note keeps the non-URL remainder of the share text.
    expect(draft.note).toBe('一些备注');
  });

  it('extracts the url from text when the url param is missing', () => {
    const draft = parseShareTarget({
      url: null,
      title: '',
      text: '好文章 https://blog.example.org/post 值得读',
    });
    expect(draft.url).toBe('https://blog.example.org/post');
    expect(draft.note).toBe('好文章 值得读');
    // No explicit title → the leftover text becomes one.
    expect(draft.title).toBe('好文章 值得读');
  });

  it('normalizes a scheme-less url param', () => {
    const draft = parseShareTarget({ url: 'example.com/path', title: '', text: '' });
    expect(draft.url).toBe('https://example.com/path');
  });

  it('rejects non-http schemes', () => {
    const draft = parseShareTarget({ url: 'javascript:alert(1)', title: '', text: '' });
    expect(draft.url).toBeNull();
    // Without a usable URL the raw text is preserved for manual entry.
    expect(draft.note).toBe('');
  });

  it('keeps the full text as note when no url can be recovered', () => {
    const draft = parseShareTarget({ url: '', title: '', text: '纯文字分享，没有链接' });
    expect(draft.url).toBeNull();
    expect(draft.note).toBe('纯文字分享，没有链接');
  });

  it('handles all-empty params without throwing', () => {
    const draft = parseShareTarget({});
    expect(draft).toEqual({ url: null, title: '', note: '' });
  });
});

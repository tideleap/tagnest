import { describe, it, expect } from 'vitest';
import { decodeUploadBytes } from '../functions/_lib/encoding';
import { parseNetscapeHtml, detectSource, parseBySource } from '../functions/_lib/import-parsers';

const GBK = { '知': [0xd6, 0xaa], '乎': [0xba, 0xee] };
function gbkEncode(str) {
  const out = [];
  for (const ch of str) {
    const g = GBK[ch];
    if (g) out.push(...g);
    else for (const b of new TextEncoder().encode(ch)) out.push(b);
  }
  return out;
}

// Integration: the exact path preview.ts now uses — decode bytes, then parse.
function previewDecodeParse(src: Uint8Array, name = 'bookmarks') {
  const { text, encoding } = decodeUploadBytes(src);
  const source = detectSource(name, text);
  return { source, encoding, outcome: parseBySource(source, text) };
}

describe('import fix integration (decode → detect → parse)', () => {
  it('parses a GBK Chrome export that would previously garble to 解析失败', () => {
    const ascii = '<DL><p><DT><A HREF="https://zhihu.com/" ADD_DATE="1620000001">';
    const body = new Uint8Array([...new TextEncoder().encode(ascii), ...gbkEncode('知乎'), ...new TextEncoder().encode('</A></DL>')]);
    const { source, encoding, outcome } = previewDecodeParse(body);
    expect(source).toBe('html');
    expect(encoding).toBe('gbk');
    expect(outcome.items.length).toBe(1);
    // ASCII structure (HREF) survives; title may be degraded but parse succeeds.
    expect(outcome.items[0].url).toBe('https://zhihu.com/');
  });

  it('parses a standard UTF-8 Chrome export unchanged', () => {
    const html = '<DL><p><DT><A HREF="https://github.com/" ADD_DATE="1620000001">GitHub</A></DL>';
    const { source, encoding, outcome } = previewDecodeParse(new TextEncoder().encode(html));
    expect(source).toBe('html');
    expect(encoding).toBe('utf-8');
    expect(outcome.items[0].title).toBe('GitHub');
  });

  it('detects a JSON export even without a matching extension and parses it', () => {
    const json = JSON.stringify([{ uri: 'https://a.com/', name: 'A' }]);
    const { source, outcome } = previewDecodeParse(new TextEncoder().encode(json), 'bookmarks');
    expect(source).toBe('json');
    expect(outcome.items[0]).toMatchObject({ url: 'https://a.com/', title: 'A' });
  });

  it('never throws on arbitrary/binary bytes (defensive guarantee)', () => {
    expect(() => parseNetscapeHtml(decodeUploadBytes(new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0x40])).text)).not.toThrow();
  });
});

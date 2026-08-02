import { describe, it, expect } from 'vitest';
import { decodeUploadBytes } from '../functions/_lib/encoding';

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('decodeUploadBytes', () => {
  it('decodes clean UTF-8', () => {
    const { text, encoding } = decodeUploadBytes(bytes('<A HREF="https://a.com/">中</A>'));
    expect(encoding).toBe('utf-8');
    expect(text).toContain('中');
  });

  it('strips a UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('<A>')]);
    const { text, encoding } = decodeUploadBytes(withBom);
    expect(encoding).toBe('utf-8');
    expect(text).toBe('<A>');
  });

  it('decodes UTF-16LE with BOM', () => {
    const raw = '<A HREF="https://a.com/">x</A>';
    // Build a real UTF-16LE buffer: BOM FF FE + chars as UTF-16LE units.
    const chars = [...raw].map((c) => c.charCodeAt(0));
    const buf = new Uint8Array(2 + chars.length * 2);
    buf[0] = 0xff;
    buf[1] = 0xfe;
    chars.forEach((c, i) => {
      buf[2 + i * 2] = c & 0xff;
      buf[2 + i * 2 + 1] = c >> 8;
    });
    const { text, encoding } = decodeUploadBytes(buf);
    expect(encoding).toBe('utf-16le');
    expect(text).toBe(raw);
  });

  it('preserves the ASCII structure for GBK multi-byte content', () => {
    // GBK "知乎" in two 2-byte pairs; the HREF attr stays ASCII.
    const ascii = new TextEncoder().encode('https://zhihu.com/');
    const gbkTitle = [0xd6, 0xaa, 0xba, 0xec]; // "知乎" as GBK bytes
    const src = new Uint8Array([
      ...bytes('<A HREF="'),
      ...ascii,
      ...bytes('">'),
      ...gbkTitle,
      ...bytes('</A>'),
    ]);
    const { text, encoding } = decodeUploadBytes(src);
    // Should not be strict-UTF-8 (GBK bytes are invalid UTF-8), so it falls to GBK.
    expect(encoding).toBe('gbk');
    // ASCII structure must survive intact so the parser can read the HREF.
    expect(text).toContain('<A HREF="https://zhihu.com/">');
  });

  it('always succeeds (never throws) even on arbitrary bytes', () => {
    const junk = new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0x40, 0xfe]);
    expect(() => decodeUploadBytes(junk)).not.toThrow();
  });
});

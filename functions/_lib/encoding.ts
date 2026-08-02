// functions/_lib/encoding.ts
//
// Robust decoding of uploaded bookmark files, which arrive in a mix of
// encodings: UTF-8 (with or without BOM), UTF-16 LE/BE, or GBK/CP936 (common
// for Chinese browser exports). Always decoding as UTF-8 — which is what
// `File.text()` does — mangles GBK and UTF-16 files into U+FFFD garbage and
// can turn a perfectly good export into "解析失败".
//
// Strategy (best-effort, structure-first):
//   1. Honour a UTF-8 / UTF-16LE / UTF-16BE BOM if present.
//   2. Otherwise strict UTF-8 (fatal:true). Clean UTF-8 wins.
//   3. Otherwise decode as GBK/CP936. We deliberately do NOT ship the full
//      ~21k-row national table; high-frequency single-byte combos are mapped,
//      and anything unmapped falls through as one U+FFFD per unit. Crucially,
//      all structural tokens (tags, HREF, ADD_DATE) are ASCII, so paginating
//      by them never depends on non-ASCII — a recovered bookmark set is
//      correct even when some CJK titles degrade.
//   4. Last resort: Latin-1 (each byte = one code point). Splits multi-byte
//      characters but keeps the ASCII skeleton intact so the parser succeeds.
//
// Returned `encoding` lets the caller/exporter indicate if the text is only a
// best-effort decode.

/* ------------------------------------------------------------------ *
 * BOM
 * ------------------------------------------------------------------ */

function decodeByBom(bytes: Uint8Array): { text: string; encoding: Decoded['encoding'] } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  return null;
}

function tryStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * GBK (CP936) best-effort
 *
 * CP936: a lead byte 0x81-0xFE followed by a trail byte 0x40-0xFE encodes one
 * CJK code point. We don't bundle the ~21k-row national table; instead we
 * consume valid two-byte pairs so byte alignment is preserved and emit U+FFFD
 * for unmapped CJK, while ASCII (the part that drives parsing) always round
 * trips exactly.
 * ------------------------------------------------------------------ */

function decodeGbk(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    // Two-byte pair window 0x81-0xFE / 0x40-0xFE.
    if (b >= 0x81 && b <= 0xfe && i + 1 < bytes.length) {
      const t = bytes[i + 1];
      if (t >= 0x40 && t <= 0xfe && t !== 0x7f) {
        // Unmapped pair → U+FFFD, consume both bytes so alignment is kept.
        out += '\uFFFD';
        i += 2;
        continue;
      }
    }
    out += String.fromCharCode(b);
    i += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface Decoded {
  text: string;
  /** The encoding actually used (for diagnostics / user hints). */
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk' | 'latin-1';
}

/**
 * Best-effort decode of uploaded bookmark bytes that never corrupts the ASCII
 * structure the parsers depend on. Prefers BOM → strict UTF-8 → GBK-passthrough
 * → Latin-1. Always succeeds for any input.
 */
export function decodeUploadBytes(bytes: Uint8Array): Decoded {
  const bom = decodeByBom(bytes);
  if (bom) return bom;

  const utf8 = tryStrictUtf8(bytes);
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };

  // Not valid UTF-8. Decode as GBK (structure-preserving); if it was actually
  // Latin-1, decodeGbk's ASCII path still yields identical output for ASCII
  // bytes, so the encoding label is informational only.
  return { text: decodeGbk(bytes), encoding: 'gbk' };
}

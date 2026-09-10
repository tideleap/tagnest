// check-theme-consistency.mjs
//
// Guards against palette drift between:
//   (G-03/G-04) the SPA (src/styles/theme.css) and the unpacked extension
//               (extension/popup/popup.css, extension/options/options.css),
//               whose palette blocks are hand-mirrored copies of the SPA's
//               `--p-*` tokens (with the `--p-` prefix dropped).
//   (G-05)      src/lib/themes.ts `swatch` preview colors and theme.css's
//               first hex declaration for the same theme — they must match
//               verbatim so the settings picker swatch never lies.
//
// Exit code 0 = consistent, 1 = drift.
//
// Usage: node scripts/check-theme-consistency.mjs
// Wired into CI (ci.yml) and available as `npm run themes:check`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPA = resolve(ROOT, 'src', 'styles', 'theme.css');
const TS = resolve(ROOT, 'src', 'lib', 'themes.ts');
const EXT_FILES = ['extension/popup/popup.css', 'extension/options/options.css'].map((f) =>
  resolve(ROOT, f),
);

// Tokens compared between SPA and extension. `ink-muted` / `brand-accent` /
// `focus` added per audit §1.10 (present in SPA; extension mirrors them where
// relevant — the comparison only runs on tokens present in BOTH).
const TOKENS = [
  'canvas',
  'surface',
  'surface-hover',
  'sunken',
  'ink',
  'ink-soft',
  'ink-faint',
  'ink-muted',
  'line',
  'line-strong',
  'brand',
  'brand-hover',
  'brand-soft',
  'brand-ink',
  'brand-accent',
  'focus',
  'on-brand',
  'positive',
  'positive-soft',
  'positive-ink',
  'caution',
  'caution-soft',
  'caution-ink',
  'critical',
  'critical-hover',
  'critical-soft',
  'critical-ink',
];

// Extract { theme: { token: lastValue } } from a CSS file. `prefix` is '--p-'
// for the SPA and '--' for the extension.
// Fixes the G-03 blind spot: handles `:root` (→ 'light') and compound selectors
// like `[data-theme='dark'], .dark` (audit §1.10).
function parsePalettes(css, prefix = '--p-') {
  const palettes = {};
  const SELECTOR = /(^|\})\s*([^{}]+?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = SELECTOR.exec(css)) !== null) {
    const selector = m[2].trim();
    const body = m[3];
    let theme = null;
    if (/^:root$/.test(selector)) theme = 'light';
    else {
      const attr = selector.match(/\[data-theme='([^']+)'\]/);
      if (attr) theme = attr[1];
    }
    if (!theme) continue;
    palettes[theme] = palettes[theme] || {};
    for (const t of TOKENS) {
      const re = new RegExp(`--${prefix}${t}\\s*:\\s*([^;]+);`, 'g');
      const matches = [...body.matchAll(re)];
      if (matches.length) {
        // last declaration wins (oklch overrides the hex fallback)
        palettes[theme][t] = matches[matches.length - 1][1].replace(/\s+/g, ' ').trim();
      }
    }
  }
  return palettes;
}

// G-05: parse themes.ts swatch preview hex and compare to theme.css's first hex
// declaration per token. Returns list of { theme, token, ts, css }.
function checkThemesTsSwatch(spaPalettes) {
  const ts = readFileSync(TS, 'utf8');
  const drift = [];
  const blockRe =
    /value:\s*'(\w+)'\s*,\s*\n\s*label:[^}]*?swatch:\s*\{\s*canvas:\s*'([^']+)',\s*surface:\s*'([^']+)',\s*accent:\s*'([^']+)',\s*ink:\s*'([^']+)'\s*\}/g;
  let bm;
  while ((bm = blockRe.exec(ts)) !== null) {
    const theme = bm[1];
    if (theme === 'system') continue; // system is not a real palette
    const sw = { canvas: bm[2], surface: bm[3], accent: bm[4], ink: bm[5] };
    const map = { canvas: 'canvas', surface: 'surface', accent: 'brand', ink: 'ink' };
    const spa = spaPalettes[theme];
    if (!spa) continue;
    for (const [tsKey, cssToken] of Object.entries(map)) {
      // theme.css first hex declaration for --p-<cssToken>
      const firstHex = firstHexOf(spa, cssToken);
      if (!firstHex) continue;
      const tsHex = normalizeHex(sw[tsKey]);
      if (tsHex !== firstHex.toLowerCase()) {
        drift.push({ theme, token: tsKey, ts: sw[tsKey], css: firstHex });
      }
    }
  }
  return drift;
}

// Given a parsed SPA palette { token: 'oklch(...) #HEX' or 'oklch(...)'; },
// pull the FIRST hex declaration of `--p-<token>` from the raw theme.css.
function firstHexOf(palette, token) {
  return palette.__firstHex?.[token] || null;
}

function normalizeHex(h) {
  return h.trim().toLowerCase();
}

function main() {
  const spaCss = readFileSync(SPA, 'utf8');

  // Parse SPA palettes AND capture first-hex declarations for G-05.
  const spa = parsePalettes(spaCss, '--p-');
  spa.__firstHex = captureFirstHex(spaCss);

  let drift = 0;

  // ---- G-04: SPA ↔ extension ----
  for (const file of EXT_FILES) {
    const ext = parsePalettes(readFileSync(file, 'utf8'), '--');
    for (const [theme, extTokens] of Object.entries(ext)) {
      const spaTokens = spa[theme];
      if (!spaTokens) continue;
      for (const [token, extValue] of Object.entries(extTokens)) {
        const spaValue = spaTokens[token];
        if (spaValue === undefined) continue;
        const a = spaValue.replace(/\s+/g, '');
        const b = extValue.replace(/\s+/g, '');
        if (a !== b) {
          console.error(
            `✗ drift: ${file.split(/[/\\]/).pop()} [${theme}] --${token}\n` +
              `    SPA:   ${spaValue}\n    ext:   ${extValue}`,
          );
          drift += 1;
        }
      }
    }
  }

  // ---- G-05: themes.ts swatch ↔ theme.css first hex ----
  const tsDrift = checkThemesTsSwatch(spa);
  for (const d of tsDrift) {
    console.error(
      `✗ swatch drift: themes.ts [${d.theme}] ${d.token}\n` +
        `    themes.ts: ${d.ts}\n    theme.css: ${d.css}`,
    );
    drift += 1;
  }

  if (drift > 0) {
    console.error(`\n✗ theme drift: ${drift} mismatch(es). Fix the extension CSS mirrors or theme.css / themes.ts.`);
    process.exit(1);
  }
  console.log('✓ theme palette consistent across SPA, extension (popup + options), and themes.ts swatch.');
}

// Capture the FIRST hex declaration of each `--p-<token>` per theme block,
// keyed by theme. Used by the G-05 swatch check.
function captureFirstHex(css) {
  const out = {};
  const SELECTOR = /(^|\})\s*([^{}]+?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = SELECTOR.exec(css)) !== null) {
    const selector = m[2].trim();
    const body = m[3];
    let theme = null;
    if (/^:root$/.test(selector)) theme = 'light';
    else {
      const attr = selector.match(/\[data-theme='([^']+)'\]/);
      if (attr) theme = attr[1];
    }
    if (!theme) continue;
    out[theme] = out[theme] || {};
    for (const t of TOKENS) {
      const re = new RegExp(`--p-${t}\\s*:\\s*(#([0-9a-f]{6})[^;]*);`, 'i');
      const mm = body.match(re);
      if (mm) out[theme][t] = mm[1];
    }
  }
  return out;
}

main();

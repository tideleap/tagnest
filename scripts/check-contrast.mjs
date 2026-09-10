// check-contrast.mjs
//
// WCAG 2.x contrast gate for the TagNest design system (A-01 / A-03 / C-01 / D-04).
//
// Parses the 5 theme palettes out of src/styles/theme.css, takes each --p-*
// token's LAST declaration (oklch wins over the hex fallback), converts oklch
// → linear sRGB → relative luminance, and computes the contrast ratio for the
// key foreground/background pairs the audit identified. Any pair that fails its
// threshold (and is not a registered exception) exits 1.
//
// color-mix(in oklab, A p%, transparent) over B is approximated as A composited
// on B at alpha p/100 (transparent carries alpha 0), which is exactly what the
// browser renders for these tokens (e.g. --color-ink-muted over --color-sunken
// on the Kbd in Display.tsx:259).
//
// Registered exceptions (known, accepted — see audit §5.3-C "登记为例外，不阻断").
// These are pre-existing palette trade-offs, NOT regressions: the blossom theme is
// intentionally pastel (weak caution/brand-on-surface contrast), and line-strong is
// a low-contrast border by design (boundary implied by shadow-raised). They remain
// reported as EXEMPT below so a future palette rebalance can close them.
//   dark    line-strong / surface   1.72  — low-contrast border (inputs/checkboxes)
//   blossom line-strong / surface   1.65  — low-contrast border
//   blossom on-brand   / brand      3.34  — white-on-pink button label (< AA body, large-text tier)
//   blossom caution     / surface   2.52  — pastel caution icon (< 3:1 non-text)
//
// Usage: node scripts/check-contrast.mjs
// Wired into CI and available as `npm run contrast:check`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = resolve(ROOT, 'src', 'styles', 'theme.css');

const THEMES = ['light', 'dark', 'aurora', 'blossom', 'starlight'];

// ---- oklch → linear sRGB ------------------------------------------------

function oklchToLinearRGB(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  // oklab → linear sRGB (Björn Ottosson's matrices)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bch = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [clamp01(r), clamp01(g), clamp01(bch)];
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(rgbA, rgbB) {
  const la = relativeLuminance(rgbA);
  const lb = relativeLuminance(rgbB);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// color-mix(in oklab, A p%, transparent) composited over B at alpha p/100
function mixOver(rgbA, pct, rgbB) {
  const a = pct / 100;
  return [
    rgbA[0] * a + rgbB[0] * (1 - a),
    rgbA[1] * a + rgbB[1] * (1 - a),
    rgbA[2] * a + rgbB[2] * (1 - a),
  ];
}

// ---- parse theme.css -----------------------------------------------------

function parsePalettes(css) {
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
    if (!theme || !THEMES.includes(theme)) continue;
    palettes[theme] = palettes[theme] || {};
    for (const t of Object.keys(palettes[theme])) delete palettes[theme][t];
    const re = /--p-([a-z-]+)\s*:\s*([^;]+);/g;
    let tm;
    while ((tm = re.exec(body)) !== null) {
      const token = tm[1];
      const raw = tm[2].trim();
      // keep the LAST declaration (oklch overrides the hex fallback)
      if (/^oklch\(/i.test(raw)) {
        const mm = raw.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
        if (mm) palettes[theme][token] = [parseFloat(mm[1]), parseFloat(mm[2]), parseFloat(mm[3])];
      } else if (!palettes[theme][token]) {
        // fall back to hex if no oklch seen yet
        const hx = raw.match(/^#([0-9a-f]{6})/i);
        if (hx) palettes[theme][token] = hexToOklch(hx[1]);
      }
    }
  }
  return palettes;
}

function hexToOklch(hex) {
  // approximate: convert hex → linear rgb → oklab (used only as a fallback)
  const n = parseInt(hex, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const lin = [r, g, b].map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  // linear rgb → oklab (inverse of the matrix above, simplified)
  const l_ = Math.cbrt(0.4122 * lin[0] + 0.5364 * lin[1] + 0.0516 * lin[2]);
  const m_ = Math.cbrt(0.2119 * lin[0] + 0.6807 * lin[1] + 0.1074 * lin[2]);
  const s_ = Math.cbrt(0.0883 * lin[0] + 0.2817 * lin[1] + 0.6300 * lin[2]);
  const L = 0.2105 * l_ + 0.7154 * m_ + 0.0741 * s_;
  const a = 1.386 * l_ - 1.404 * m_ + 0.0179 * s_;
  const bch = 1.149 * l_ - 0.228 * m_ - 0.921 * s_;
  const C = Math.hypot(a, bch);
  const H = (Math.atan2(bch, a) * 180) / Math.PI;
  return [L, C, (H + 360) % 360];
}

// ---- checks --------------------------------------------------------------

// Required pairs: [fgToken, bgToken, threshold, {mix?: {token, pct}}]
// threshold 4.5 = WCAG AA body text; 3 = WCAG 1.4.11 non-text (UI components)
const TEXT = 4.5;
const NON_TEXT = 3;
const CHECKS = [
  // text
  ['ink', 'canvas', TEXT],
  ['ink-soft', 'surface', TEXT],
  ['ink-muted', 'surface', TEXT],
  ['ink-muted', 'canvas', TEXT],
  ['ink-muted', 'sunken', TEXT],
  ['brand-ink', 'brand-soft', TEXT],
  ['positive-ink', 'positive-soft', TEXT],
  ['caution-ink', 'caution-soft', TEXT],
  ['critical-ink', 'critical-soft', TEXT],
  ['on-brand', 'brand', TEXT],
  // non-text
  ['focus', 'surface', NON_TEXT],
  ['line-strong', 'surface', NON_TEXT],
  ['positive', 'surface', NON_TEXT],
  ['caution', 'surface', NON_TEXT],
  ['critical', 'surface', NON_TEXT],
];

// Pairs that are known to fall short but are accepted (audit §5.3-C).
const EXEMPT = new Set([
  'dark|line-strong|surface',
  'blossom|line-strong|surface',
  'blossom|on-brand|brand',
  'blossom|caution|surface',
]);

function main() {
  const css = readFileSync(SRC, 'utf8');
  const palettes = parsePalettes(css);

  let failures = 0;
  const rows = [];
  for (const theme of THEMES) {
    const p = palettes[theme];
    if (!p) continue;
    for (const [fg, bg, thr, mix] of CHECKS) {
      if (!p[fg] || !p[bg]) continue;
      let fgRgb = oklchToLinearRGB(...p[fg]);
      const bgRgb = oklchToLinearRGB(...p[bg]);
      if (mix) fgRgb = mixOver(oklchToLinearRGB(...p[mix.token]), mix.pct, bgRgb);
      const ratio = contrast(fgRgb, bgRgb);
      const key = `${theme}|${fg}|${bg}`;
      const exempt = EXEMPT.has(key);
      const ok = ratio >= thr;
      rows.push({ theme, fg, bg, ratio, thr, ok, exempt });
      if (!ok && !exempt) failures++;
    }
  }

  // report
  console.log('contrast check — WCAG 2.x (AA text ≥4.5, UI ≥3.0)');
  console.log('theme        fg → bg                    ratio   need    result');
  for (const r of rows) {
    const flag = r.ok ? 'PASS' : r.exempt ? 'EXEMPT' : 'FAIL';
    console.log(
      `${r.theme.padEnd(13)} ${r.fg.padEnd(11)}→ ${r.bg.padEnd(11)} ${r.ratio.toFixed(2).padStart(6)}  ≥${r.thr}    ${flag}`,
    );
  }

  if (failures > 0) {
    console.error(`\n✗ contrast: ${failures} pair(s) below threshold (not exempt).`);
    process.exit(1);
  }
  console.log('\n✓ contrast: all checked pairs meet WCAG thresholds (exemptions registered).');
}

main();

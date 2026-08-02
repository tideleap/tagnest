// check-theme-consistency.mjs
//
// Guards against palette drift between the SPA (src/styles/theme.css) and the
// unpacked extension (extension/popup/popup.css, extension/options/options.css).
//
// The extension has no shared build with the app, so its palette blocks are
// hand-mirrored copies of the SPA's `--p-*` tokens (with the `--p-` prefix
// dropped). If someone tweaks a theme hue in theme.css and forgets the mirrors,
// the popup/options silently diverge from the app. This script catches that:
// for every theme block and every token that exists in BOTH, the oklch value
// must match (whitespace-insensitive). Exit code 0 = consistent, 1 = drift.
//
// Usage: node scripts/check-theme-consistency.mjs
// Wired into CI (ci.yml) and available as `npm run themes:check`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPA = resolve(ROOT, 'src', 'styles', 'theme.css');
const EXT_FILES = ['extension/popup/popup.css', 'extension/options/options.css'].map((f) =>
  resolve(ROOT, f),
);

const TOKENS = [
  'canvas',
  'surface',
  'surface-hover',
  'sunken',
  'ink',
  'ink-soft',
  'ink-faint',
  'line',
  'line-strong',
  'brand',
  'brand-hover',
  'brand-soft',
  'brand-ink',
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

// Extract { theme: { token: value } } from a CSS file. `prefix` is `--p-` for
// the SPA and `--` for the extension (tokens are `--p-<name>` vs `--<name>`).
function parsePalettes(css, prefix = '--p-') {
  const palettes = {};
  const blocks = css.split(/\[data-theme='([^']+)'\]\s*\{/g);
  // blocks = [head, theme1, body1, theme2, body2, ...]
  for (let i = 1; i + 1 < blocks.length; i += 2) {
    const theme = blocks[i];
    const body = blocks[i + 1];
    const palette = {};
    for (const m of body.matchAll(
      new RegExp(`(${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-z-]+)\\s*:\\s*([^;]+);`, 'g'),
    )) {
      const token = m[1].slice(prefix.length);
      if (TOKENS.includes(token)) palette[token] = m[2].trim();
    }
    palettes[theme] = palette;
  }
  return palettes;
}

const spa = parsePalettes(readFileSync(SPA, 'utf8'), '--p-');
let drift = 0;

for (const file of EXT_FILES) {
  // Extension blocks use `--<name>` (no `--p-` prefix).
  const ext = parsePalettes(readFileSync(file, 'utf8'), '--');
  for (const [theme, extTokens] of Object.entries(ext)) {
    const spaTokens = spa[theme];
    if (!spaTokens) continue; // theme not in SPA (e.g. system) — nothing to compare
    for (const [token, extValue] of Object.entries(extTokens)) {
      const spaValue = spaTokens[token];
      if (spaValue === undefined) continue; // token not present in SPA block
      const a = spaValue.replace(/\s+/g, '');
      const b = extValue.replace(/\s+/g, '');
      if (a !== b) {
        console.error(
          `✗ drift: ${file.split(/[/\\]/).pop()} [${theme}] --${token}\n` +
            `    SPA:   ${spaValue}\n` +
            `    ext:   ${extValue}`,
        );
        drift += 1;
      }
    }
  }
}

if (drift > 0) {
  console.error(`\n✗ theme drift: ${drift} mismatch(es). Fix the extension CSS mirrors or theme.css.`);
  process.exit(1);
}
console.log('✓ theme palette consistent across SPA and extension (popup + options).');

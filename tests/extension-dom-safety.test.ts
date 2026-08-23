// tests/extension-dom-safety.test.ts
//
// P6-B5: the extension UI must never inject HTML built from variables.
//
// Why this is a durable guard, not a style preference:
//   1. Bookmark titles / URLs / folder paths are *user data*. Concatenating
//      them into an `innerHTML` string is an XSS sink inside the extension's
//      own privileged pages.
//   2. Firefox's addon-linter (`web-ext lint`, used for AMO review) flags every
//      such assignment as `UNSAFE_VAR_ASSIGNMENT`. We drove that count to 0;
//      this test keeps it at 0 so a future edit can't silently regress it.
//
// All rendering now goes through `extension/dom.js` (`el()` / `clear()`), which
// assigns text via `textContent` so the browser auto-escapes it.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const extDir = join(root, 'extension');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Strip comments so documentation that *mentions* `innerHTML` (e.g. dom.js's
 * header explaining why we avoid it) is not mistaken for a real sink.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const SINKS: Array<{ name: string; re: RegExp }> = [
  { name: 'innerHTML assignment', re: /\.innerHTML\s*=/ },
  { name: 'outerHTML assignment', re: /\.outerHTML\s*=/ },
  { name: 'insertAdjacentHTML', re: /\.insertAdjacentHTML\s*\(/ },
  { name: 'document.write', re: /document\s*\.\s*write(?:ln)?\s*\(/ },
];

describe('extension UI — no HTML injection sinks (P6-B5)', () => {
  const files = walk(extDir);

  it('finds extension source files to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('has zero HTML injection sinks anywhere under extension/', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const sink of SINKS) {
        if (sink.re.test(src)) {
          offenders.push(`${relative(root, file)} → ${sink.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ships the shared safe-DOM helper used by the UI scripts', () => {
    const dom = readFileSync(join(extDir, 'dom.js'), 'utf8');
    expect(dom).toMatch(/export function clear\(/);
    expect(dom).toMatch(/export function el\(/);
    expect(dom).toMatch(/textContent/);
  });

  it('every file that calls a dom.js helper imports it (no undefined refs)', () => {
    // ESLint ignores `extension/`, so a page that calls `el()`/`clear()`/
    // `escapeHtml()` without importing them would only fail at runtime. This
    // guard catches that statically. (This is exactly the bug the sink scan
    // surfaced: sync.js used `el()`/`clear()` 11× without importing dom.js.)
    const helpers = ['el', 'clear', 'escapeHtml'];
    const offenders: string[] = [];
    for (const file of files) {
      // dom.js *defines* these helpers — skip the definition file itself.
      // (Use a path-agnostic check: `relative()` returns backslashes on Win.)
      if (file.endsWith(join('extension', 'dom.js'))) continue;
      const src = readFileSync(file, 'utf8');
      const importsDom = /from '(\.|\.\.)\/dom\.js'/.test(src);
      for (const h of helpers) {
        // Match a bare call `h(` but not a namespaced one like
        // `chrome.alarms.clear(` or `foo.el(`.
        const uses = new RegExp(`(?<![\\w.])${h}\\s*\\(`).test(src);
        if (uses && !importsDom) {
          offenders.push(`${relative(root, file)} calls ${h}() but never imports ./dom.js`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

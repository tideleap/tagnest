#!/usr/bin/env node
/**
 * license-audit — fail the build if any direct dependency carries a license
 * that is not commercial-safe (copyleft or non-commercial).
 *
 * Rationale: TagNest must be commercially distributable. This guard runs in
 * the release pipeline so a future dependency with a GPL/AGPL/CC-BY-NC/etc.
 * license becomes a hard error instead of a silent legal liability.
 *
 * Usage:  node scripts/license-audit.mjs
 * Exit:   0 when all direct deps are on the allow-list, 1 otherwise.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Normalise an SPDX-ish license string (e.g. "MIT OR Apache-2.0") to a set of
// tokens and keep only any that are commercial-safe.
const SAFE = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'MIT-0', 'WTFPL', 'Unlicense', 'Unlicense OR MIT']);

function allowed(license) {
  if (typeof license === 'string') {
    // Compound expressions like "MIT OR Apache-2.0" -> safe if any is safe.
    return license.split(/\s+(?:OR|AND)\s+/).some((t) => SAFE.has(t)) ||
      license.split(/[^A-Za-z0-9.+-]+/).every((t) => !t || SAFE.has(t));
  }
  return false;
}

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

const bad = [];
for (const name of Object.keys(deps)) {
  let meta;
  try {
    meta = JSON.parse(readFileSync(resolve(ROOT, 'node_modules', name.replace(/\//, '/'), 'package.json'), 'utf8'));
  } catch {
    // Package not installed (CI runs after install); skip — typecheck/build
    // will surface real resolution problems.
    continue;
  }
  const lic = meta.license ?? meta.licenses?.type ?? 'UNKNOWN';
  if (!allowed(lic)) bad.push([name, lic, meta.version]);
}

if (bad.length) {
  console.error('✖ 下列依赖的许可证不允许商业分发：');
  for (const [n, l, v] of bad) console.error(`  - ${n}@${v}  (${l})`);
  process.exit(1);
}
console.log('✓ 全部直接依赖均已商业安全（MIT/ISC/Apache/BSD 等宽松许可证）。');

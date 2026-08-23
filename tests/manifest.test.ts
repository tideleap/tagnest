// tests/manifest.test.ts
//
// P6-B3: the MV3 manifest and the extension code must be valid for BOTH
// Chrome and Firefox. Firefox is stricter about a few things:
//   1. `default_locale: null` is invalid (we ship no `_locales` dir) → omit it.
//   2. Firefox add-ons need `browser_specific_settings.gecko.id` to load as MV3.
//   3. Every declared permission must be supported by Firefox MV3 — we must
//      never reference a Chrome-only API from the extension source.
//   4. Firefox MV3 ignores `background.service_worker` and runs
//      `background.scripts` as an event page, so BOTH must be declared
//      (Chrome 121+ ignores `scripts`; Firefox 121+ runs `scripts`). The
//      `type: "module"` applies to `scripts` too, so `import` works in FF.
//
// This test is the durable guard so a future edit can't silently break the
// "load in Firefox" property again.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const manifestPath = join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Permission / chrome.* namespace identifiers Firefox MV3 supports. If the
// extension ever needs a Chrome-only API, this set is the single place to
// acknowledge the Firefox incompatibility explicitly.
const FF_MV3_SUPPORTED = new Set([
  'activeTab',
  'tabs',
  'storage',
  'scripting',
  'alarms',
  'bookmarks',
  'notifications',
  'contextMenus',
  'commands',
  'action',
  'windows',
  'runtime',
  // chrome.permissions API (used to request optional bookmarks permission).
  'permissions',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('extension manifest — Firefox (MV3) readiness (P6-B)', () => {
  it('does not carry an invalid default_locale:null', () => {
    expect('default_locale' in manifest).toBe(false);
    expect(manifest.default_locale ?? null).toBeNull();
  });

  it('declares a Firefox gecko.id so it loads as an MV3 add-on', () => {
    const id = manifest.browser_specific_settings?.gecko?.id;
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/);
  });

  it('uses a module background service worker', () => {
    expect(manifest.background?.type).toBe('module');
    expect(typeof manifest.background?.service_worker).toBe('string');
  });

  it('declares background.scripts as the Firefox fallback (paired with service_worker)', () => {
    const scripts = manifest.background?.scripts;
    expect(Array.isArray(scripts)).toBe(true);
    expect((scripts as unknown[]).length).toBeGreaterThan(0);
    expect(scripts).toContain(manifest.background.service_worker);
  });

  it('only declares Firefox-MV3-supported permissions', () => {
    const all = [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(FF_MV3_SUPPORTED.has(p)).toBe(true);
    }
  });

  it('is a valid MV3 document', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(typeof manifest.name).toBe('string');
    expect(typeof manifest.version).toBe('string');
  });

  it('only calls Firefox-MV3-supported chrome.* namespaces in code', () => {
    const extDir = join(root, 'extension');
    const files = walk(extDir);
    const used = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/chrome\.([a-zA-Z]+)/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const ns of used) {
      expect(FF_MV3_SUPPORTED.has(ns)).toBe(true);
    }
  });
});

// tests/manifest.test.ts
//
// P6-B3 + CS-P6-fix: the extension ships TWO manifests. Chrome MV3 rejects
// `background.scripts` (error 1227774043: "Failed to load background script"),
// so the Chrome package uses `manifest.json` (service_worker only). Firefox
// MV3 in turn needs both `background.scripts` AND
// `browser_specific_settings.gecko.id`, so the Firefox package uses
// `manifest.firefox.json`. Build scripts (`scripts/build-extension.mjs`)
// swap manifests per target. This test is the durable guard so:
//   - a future edit to the Chrome manifest can't silently re-introduce
//     `background.scripts`
//   - a future edit to the Firefox manifest can't drop `scripts` or
//     `gecko.id`
//   - the two files can't drift out of sync on shared fields

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const extDir = join(root, 'extension');
const chromeManifestPath = join(extDir, 'manifest.json');
const fxManifestPath = join(extDir, 'manifest.firefox.json');
const chromeManifest = JSON.parse(readFileSync(chromeManifestPath, 'utf8'));
const fxManifest = JSON.parse(readFileSync(fxManifestPath, 'utf8'));

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

// Fields that must agree between Chrome and Firefox manifests (anything that
// would otherwise drift when both files are edited independently).
const SHARED_KEYS = [
  'name',
  'version',
  'description',
  'manifest_version',
  'permissions',
  'optional_permissions',
  'action',
  'icons',
  'options_page',
  'commands',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('manifest.json — Chrome (MV3)', () => {
  it('does not carry an invalid default_locale:null', () => {
    expect('default_locale' in chromeManifest).toBe(false);
    expect(chromeManifest.default_locale ?? null).toBeNull();
  });

  it('uses a module background service worker', () => {
    expect(chromeManifest.background?.type).toBe('module');
    expect(typeof chromeManifest.background?.service_worker).toBe('string');
  });

  // CS-P6-fix: Chrome MV3 strict-rejects background.scripts (error 1227774043).
  // This is the regression guard that flagged the original "无法加载背景脚本".
  it('does NOT declare background.scripts (Chrome MV3 rejects the combination)', () => {
    expect('scripts' in (chromeManifest.background ?? {})).toBe(false);
  });

  it('is a valid MV3 document', () => {
    expect(chromeManifest.manifest_version).toBe(3);
    expect(typeof chromeManifest.name).toBe('string');
    expect(typeof chromeManifest.version).toBe('string');
  });
});

describe('manifest.firefox.json — Firefox (MV3)', () => {
  it('uses a module background service worker', () => {
    expect(fxManifest.background?.type).toBe('module');
    expect(typeof fxManifest.background?.service_worker).toBe('string');
  });

  // Firefox MV3 needs background.scripts as the event-page fallback (or
  // prefers it when both are present). Keep both service_worker and
  // scripts so loading works whether Firefox treats MV3 background as SW
  // or event page.
  it('declares background.scripts as the Firefox fallback (paired with service_worker)', () => {
    const scripts = fxManifest.background?.scripts;
    expect(Array.isArray(scripts)).toBe(true);
    expect((scripts as unknown[]).length).toBeGreaterThan(0);
    expect(scripts).toContain(fxManifest.background.service_worker);
  });

  it('declares a Firefox gecko.id so it loads as an MV3 add-on', () => {
    const id = fxManifest.browser_specific_settings?.gecko?.id;
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/);
  });

  it('only declares Firefox-MV3-supported permissions', () => {
    const all = [
      ...(fxManifest.permissions ?? []),
      ...(fxManifest.optional_permissions ?? []),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(FF_MV3_SUPPORTED.has(p)).toBe(true);
    }
  });

  it('is a valid MV3 document', () => {
    expect(fxManifest.manifest_version).toBe(3);
    expect(typeof fxManifest.name).toBe('string');
    expect(typeof fxManifest.version).toBe('string');
  });
});

describe('manifest parity — Chrome vs Firefox', () => {
  it('agree on every shared field (so a one-off edit is hard to miss)', () => {
    for (const k of SHARED_KEYS) {
      expect(JSON.stringify(chromeManifest[k])).toBe(JSON.stringify(fxManifest[k]));
    }
  });
});

describe('extension source — Firefox (MV3) readiness', () => {
  it('only calls Firefox-MV3-supported chrome.* namespaces in code', () => {
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

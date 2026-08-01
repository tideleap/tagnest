// PWA wiring tests: the manifest must be valid JSON, reference files that
// actually exist, and the shell HTML must point at the manifest + sw.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('PWA: manifest', () => {
  it('parses and declares the app scope', () => {
    const raw = fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8');
    const m = JSON.parse(raw);
    expect(m.name).toContain('TagNest');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
  });

  it('references icon files that exist on disk', () => {
    const raw = fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8');
    const m = JSON.parse(raw);
    expect(Array.isArray(m.icons)).toBe(true);
    for (const icon of m.icons) {
      const file = path.join(root, 'public', String(icon.src).replace(/^\//, ''));
      expect(fs.existsSync(file), `missing manifest icon ${icon.src}`).toBe(true);
      expect(icon.type).toBe('image/png');
    }
    // Must include our two brand sizes.
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });
});

describe('PWA: service worker + shell wiring', () => {
  it('ships a service worker and references it from the prod entry', () => {
    const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
    expect(sw).toContain('CACHE_VERSION');
    expect(sw).toContain("'/index.html'");
    expect(sw).toContain('/api/');
    const main = fs.readFileSync(path.join(root, 'src/main.tsx'), 'utf8');
    expect(main).toContain("navigator.serviceWorker.register('/sw.js')");
    expect(main).toContain('import.meta.env.PROD');
  });

  it('links the manifest from index.html', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="theme-color"');
  });

  it('keeps /api/ network-only (never cached or stale-served)', () => {
    const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
    // The handler must detect the API path and bail out before any cache read.
    const apiBlock = /startsWith\('\/api\/'\)/;
    expect(apiBlock.test(sw)).toBe(true);
    // And the cache helpers must never be invoked for the API branch — the
    // early `return` sits right after the path check.
    const blockIndex = sw.search(apiBlock);
    expect(sw.slice(blockIndex, blockIndex + 120)).toMatch(/\n.*return;/);
  });
});

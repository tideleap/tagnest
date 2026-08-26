// scripts/build-extension.mjs
//
// Cross-browser extension packager. TagNest ships one source tree at
// `extension/`, but Chrome MV3 rejects `background.scripts` while
// Firefox MV3 needs `background.scripts`. We keep two manifests in
// `extension/`:
//   - `manifest.json`         — Chrome-only (no `background.scripts`)
//   - `manifest.firefox.json` — Firefox (declares `scripts` + `gecko.id`)
//
// Targets:
//   chrome    — copy extension/ → dist-ext/build/chrome/, replace manifest
//               with manifest.json, zip into TagNest-Chrome-0.1.0.zip
//   firefox   — copy extension/ → dist-ext/build/firefox/, replace manifest
//               with manifest.firefox.json, then run `web-ext build` into
//               TagNest-Firefox-0.1.0.xpi
//   all       — both
//
// Usage:
//   node scripts/build-extension.mjs [--target chrome|firefox|all]
//                                   [--out-dir <dir>] [--keep-build]

import { readFileSync, writeFileSync, mkdirSync, rmSync,
         createReadStream, existsSync, statSync, readdirSync,
         cpSync } from 'node:fs';
import { dirname, join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const extDir = join(root, 'extension');
const defaultOutDir = join(root, 'dist-ext');

function parseArgs(argv) {
  const args = { target: 'all', outDir: defaultOutDir, keepBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--keep-build') args.keepBuild = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/build-extension.mjs [--target chrome|firefox|all] [--out-dir <dir>] [--keep-build]');
      process.exit(0);
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertManifests() {
  const chrome = readJson(join(extDir, 'manifest.json'));
  const ff = readJson(join(extDir, 'manifest.firefox.json'));
  // Chrome must NOT declare scripts (MV3 strict).
  if (chrome.background?.scripts) {
    throw new Error('Chrome manifest still declares background.scripts — Chrome MV3 rejects this (error 1227774043)');
  }
  if (!chrome.background?.service_worker) {
    throw new Error('Chrome manifest missing background.service_worker');
  }
  // Firefox MUST declare scripts (event-page fallback) AND have gecko.id.
  if (!Array.isArray(ff.background?.scripts) || ff.background.scripts.length === 0) {
    throw new Error('Firefox manifest must declare non-empty background.scripts');
  }
  if (typeof ff.browser_specific_settings?.gecko?.id !== 'string') {
    throw new Error('Firefox manifest missing browser_specific_settings.gecko.id');
  }
  // Both manifests must agree on name, version, permissions.
  const keys = ['name', 'version', 'permissions', 'optional_permissions',
                'action', 'icons', 'options_page', 'commands'];
  for (const k of keys) {
    if (JSON.stringify(chrome[k]) !== JSON.stringify(ff[k])) {
      throw new Error(`Chrome/Firefox manifests disagree on ${JSON.stringify(k)} — sync them first`);
    }
  }
  const v = chrome.version ?? '0.0.0';
  return { chrome, ff, version: v };
}

function stageChrome(outDir, manifest) {
  const buildDir = join(outDir, 'build', 'chrome');
  // Don't rmSync the staging tree: host shell's trash hook may fail on
  // partial trees with locked files, and cpSync below already overwrites
  // files in place. Manifest fields always get the latest version. The
  // final cleanup (after the zip is built) removes the whole build/ dir.
  mkdirSync(buildDir, { recursive: true });

  // Copy the source tree — cpSync overwrites files in place.
  cpSync(extDir, buildDir, { recursive: true });
  writeFileSync(
    join(buildDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
  // Remove the Firefox-only manifest from the Chrome staging tree.
  const fxManifest = join(buildDir, 'manifest.firefox.json');
  if (existsSync(fxManifest)) {
    // best-effort: cpSync just overwrote it; we're about to zip without it,
    // so a failed delete doesn't break the zip (it just leaks the file).
    try { rmSync(fxManifest, { force: true }); } catch { /* ignore */ }
  }

  const zipName = `TagNest-Chrome-${manifest.version}.zip`;
  const zipPath = join(outDir, zipName);
  if (existsSync(zipPath)) {
    try { rmSync(zipPath, { force: true }); } catch { /* ignore */ }
  }
  return { buildDir, zipPath: zipPath };
}

function stageFirefox(outDir, manifest) {
  const buildDir = join(outDir, 'build', 'firefox');
  mkdirSync(buildDir, { recursive: true });

  cpSync(extDir, buildDir, { recursive: true });
  // Replace the (Chrome) manifest with the Firefox manifest.
  writeFileSync(
    join(buildDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
  // The Firefox manifest is now baked in — drop the source-side copy.
  const fxSrc = join(buildDir, 'manifest.firefox.json');
  if (existsSync(fxSrc)) {
    try { rmSync(fxSrc, { force: true }); } catch { /* ignore */ }
  }
  return { buildDir };
}

/**
 * Zip a directory via Node's `archiver`-free zip writer (STORE method,
 * no compression). MV3 / web-ext unpackers read DEFLATE or STORE happily;
 * STORE keeps the script simple and dependency-free.
 */
function zipDir(srcDir, outFile) {
  const files = listFiles(srcDir).map((p) => relative(srcDir, p));
  // Minimal zip: write LOCAL headers + central directory. STORE only.
  const records = [];
  const chunks = [];
  let offset = 0;

  // DOS time/date = 2020-01-01 00:00:00 (constant; we don't ship old files).
  const dosTime = (20 << 11) | (1 << 5) | 1;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;

  for (const rel of files) {
    const abs = join(srcDir, rel);
    const stat = statSync(abs);
    const data = readFileSync(abs);
    const nameBuf = Buffer.from(rel.replaceAll('\\', '/'), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // compression = STORE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0, 8);         // flags
    central.writeUInt16LE(0, 10);        // compression
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);   // local header offset

    records.push({ central, name: nameBuf });
    offset += local.length + nameBuf.length + data.length;
  }

  // Write central directory
  let centralStart = offset;
  let centralSize = 0;
  for (const r of records) {
    chunks.push(r.central, r.name);
    centralSize += r.central.length + r.name.length;
  }

  // End-of-central-directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  mkdirSync(dirname(outFile), { recursive: true });
  const ws = createWriteStream(outFile);
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('finish', () => resolve(outFile));
    for (const c of chunks) ws.write(c);
    ws.end();
  });
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

// CRC32 (IEEE 802.3 polynomial 0xEDB88320) — used by zip local + central
// headers. Pre-computed table is faster, but a 256-entry loop is plenty
// for a few hundred extension files.
function crc32(buf) {
  let c;
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ -1) >>> 0;
}

async function buildChrome(outDir, manifest) {
  console.log('[chrome] staging...');
  const { buildDir, zipPath } = stageChrome(outDir, manifest);
  console.log(`[chrome] zip → ${zipPath}`);
  await zipDir(buildDir, zipPath);
  console.log(`[chrome] unzip dir → ${buildDir}`);
  return { buildDir, zipPath };
}

// Run web-ext build to produce the .xpi. web-ext silently mangles
// non-ASCII names, so we build into a scratch dir then rename to a
// canonical `<project>-<browser>-<version>.<ext>` filename ourselves.
async function buildFirefox(outDir, manifest) {
  console.log('[firefox] staging...');
  const { buildDir } = stageFirefox(outDir, manifest);

  const scratchDir = join(outDir, '.web-ext-scratch');
  mkdirSync(scratchDir, { recursive: true });

  // web-ext requires --source-dir + --artifacts-dir; we point artifacts
  // at scratch so the canonical file isn't overwritten by a stray default.
  console.log('[firefox] web-ext build → scratch');
  const r = spawnSync(
    'npx',
    ['--yes', 'web-ext', 'build',
     '--source-dir', buildDir,
     '--artifacts-dir', scratchDir,
     '--overwrite-dest',
     '--no-input'],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (r.status !== 0) {
    throw new Error(`web-ext build failed with exit ${r.status}`);
  }

  // Pick the most recently produced artifact (zip or xpi) and rename.
  const produced = readdirSync(scratchDir)
    .filter((f) => /\.(zip|xpi)$/i.test(f))
    .map((f) => ({ f, mtime: statSync(join(scratchDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!produced) {
    throw new Error('web-ext produced no .zip/.xpi artifact');
  }
  const producedPath = join(scratchDir, produced.f);
  const xpiName = `TagNest-Firefox-${manifest.version}.xpi`;
  const xpiPath = join(outDir, xpiName);
  if (existsSync(xpiPath)) {
    try { rmSync(xpiPath, { force: true }); } catch { /* ignore */ }
  }
  const { renameSync } = await import('node:fs');
  renameSync(producedPath, xpiPath);
  // best-effort scratch cleanup; never fail the build on this.
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { buildDir, xpiPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { chrome, ff, version } = assertManifests();

  const wantChrome = args.target === 'chrome' || args.target === 'all';
  const wantFirefox = args.target === 'firefox' || args.target === 'all';

  if (!existsSync(args.outDir)) mkdirSync(args.outDir, { recursive: true });

  const results = [];
  if (wantChrome) {
    results.push(['chrome', await buildChrome(args.outDir, chrome)]);
  }
  if (wantFirefox) {
    results.push(['firefox', await buildFirefox(args.outDir, ff)]);
  }
  if (!wantChrome && !wantFirefox) {
    console.error(`Unknown target: ${args.target}`);
    process.exit(2);
  }

  // Cleanup staging trees unless --keep-build was passed.
  if (!args.keepBuild) {
    const buildRoot = join(args.outDir, 'build');
    if (existsSync(buildRoot)) {
      try { rmSync(buildRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log('\nDone. Artifacts:');
  for (const [target, info] of results) {
    const path = info.xpiPath ?? info.zipPath ?? info.buildDir;
    console.log(`  [${target}] ${path}`);
  }
  console.log(`\n(Version: ${version})`);
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? err);
  process.exit(1);
});

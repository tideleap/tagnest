#!/usr/bin/env node
// health-check.mjs — post-deploy health verification for the deploy pipeline.
//
// Polls the production (or any provided) base URL's /api/health and confirms
// the API returns `{"status":"ok", ...}`. Used right after a Cloudflare Pages
// deploy so the release is considered "live" only when the deployed Functions +
// D1 are actually answering — not merely when the upload succeeded.
//
// Exit codes:
//   0  health OK (optionally after `--retries`)
//   1  service unhealthy / not ready within the window
//   2  caller error (bad URL, no Base)
//
// Options:
//   --base=<url>    base URL to probe (default https://tagnest.pages.dev)
//   --retries=N     how many total attempts (default 6)
//   --interval=ms   ms between attempts (default 8000)
//   --timeout=ms    per-request timeout (default 15000)
//
// Example:
//   node scripts/health-check.mjs \
//     --base=https://example.tagnest.pages.dev --retries=6 --interval=8000
import { spawnSync, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const base = (arg('base', 'https://tagnest.pages.dev') || '').replace(/\/$/, '');
if (!base) {
  console.error('health-check: missing --base');
  process.exit(2);
}
const retries = Number(arg('retries', '6'));
const interval = Number(arg('interval', '8000'));
const timeout = Number(arg('timeout', '15000'));

const HEALTH_URL = `${base}/api/health?_cb=${Date.now()}`;

function probe() {
  // Prefer curl when available (Node fetch needs >=18 and CA config); fall
  // back to a minimal node fetch. curl is present in the ubuntu runner.
  const curl = spawnSync('curl', ['-s', '--max-time', String(Math.floor(timeout / 1000)), HEALTH_URL], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (curl.status === 0 && curl.stdout) return curl.stdout.trim();
  return '';
}

function classify(body) {
  // Accept either the strict JSON `{"status":"ok"}` or a truthy ok field.
  try {
    const o = JSON.parse(body);
    if (o && (o.status === 'ok' || o.ok === true)) return { ok: true, detail: o };
    return { ok: false, detail: o };
  } catch {
    return { ok: false, detail: body || 'empty response' };
  }
}

for (let attempt = 1; attempt <= retries; attempt++) {
  const body = probe();
  const state = classify(body);
  if (state.ok) {
    console.log(
      `health OK (attempt ${attempt}/${retries}) — ${base}/api/health → ${JSON.stringify(state.detail)}`,
    );
    process.exit(0);
  }
  if (attempt < retries) {
    console.log(
      `health not ready (attempt ${attempt}/${retries}); waiting ${interval}ms… response=${JSON.stringify(state.detail)}`,
    );
    // Blocking delay between polls. `sleep` exists on the ubuntu runner and is
    // the simplest cross-shell way to pause a synchronous poll loop.
    try {
      execSync(`sleep ${Math.max(1, Math.floor(interval / 1000))}`, { stdio: 'ignore' });
    } catch {
      /* ignore; a failed sleep just shortens the wait */
    }
  } else {
    console.error(
      `health FAILED after ${retries} attempts — ${base}/api/health returned: ${JSON.stringify(state.detail)}`,
    );
  }
}
process.exit(1);

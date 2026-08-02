// probe-d1.mjs — lightweight Cloudflare D1 reachability / permission check.
//
// Used by the deploy workflow to decide whether a release *must* run schema
// migrations (D1 reachable — migrations become BLOCKING) or may degrade (D1
// scope missing on the token — skip migrations, ship the static site, and flag
// the gap in the deployment summary).
//
// Exit code: 0  = D1 reachable (token can run `d1 execute`)
//            1  = D1 NOT reachable (missing / insufficient Cloudflare creds or
//                 the token lacks `Account > D1 > Edit` scope)
//
// It performs the cheapest possible query so it adds almost no latency to CI.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DB_NAME = 'tagnest-db';
const WRANGLER_CLI = resolve(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const REMOTE_FLAG = '--remote';

function run() {
  const res = spawnSync(
    process.execPath,
    [WRANGLER_CLI, 'd1', 'execute', DB_NAME, REMOTE_FLAG, '--command', 'SELECT 1 AS ok'],
    {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        // Unset any local proxy so remote metadata calls don't hang.
        http_proxy: '',
        https_proxy: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        all_proxy: '',
        ALL_PROXY: '',
      },
    },
  );
  return res;
}

const res = run();
const out = (res.stdout ?? '') + (res.stderr ?? '');
if (res.status === 0) {
  console.log('D1 reachable: yes');
  process.exit(0);
}

// Distinguish "permission missing" from a transient infra hiccup loosely: any
// non-zero exit from `d1 execute` on the remote means we cannot migrate right
// now. The caller treats it as a degraded (skip) — a real migration attempt
// still runs after the probe only when reachable, and is then blocking.
if (/given account is not valid|not authorized|7403|7511/i.test(out)) {
  console.log('D1 reachable: no (token lacks D1 scope)');
} else {
  console.log('D1 reachable: no (' + (out.split('\n').filter(Boolean).slice(-1)[0] || 'unknown error') + ')');
}
process.exit(1);

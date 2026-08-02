#!/usr/bin/env node
// rollback.mjs — automatic rollback to the last stable release.
//
// Cloudflare Pages deploys are immutable (each is a new URL), so "rollback"
// means: rebuild and re-deploy the *previous* stable commit that is known to
// have passed health. On a broken release this restores service within minutes
// and leaves a clear log line for postmortem.
//
// How it picks the target commit:
//   --ref=<ref>       explicit target (default detects the SHA that was live
//                     before this run — see workflow usage).
//   --project=<name>  Pages project (default tagnest).
//   --branch=<name>   Pages branch (default main).
//
// Behaviour:
//   1. Resolve the target commit from a worktree (clean checkout of <ref>).
//   2. npm ci + build in that worktree.
//   3. health-check the EXISTING live site (precondition — do not log a
//      rollback attempt over an already-unhealthy site blindly; but we do run
//      it to capture state).
//   4. Deploy the rebuilt dist to Pages.
//   5. health-check the new deployment; only exit 0 if it is healthy.
//
// Exit codes:
//   0  rebuilt + deployed + health OK
//   1  any step failed (build / deploy / health)
//   2  caller error / ref missing
//
// This script is invoked by .github/workflows/deploy.yml when the post-deploy
// health gate fails.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const ref = arg('ref', '').trim();
if (!ref) {
  console.error('rollback: missing --ref (target commit to restore)');
  process.exit(2);
}
const project = arg('project', 'tagnest');
const branch = arg('branch', 'main');
const base = arg('base', 'https://tagnest.pages.dev').replace(/\/$/, '');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
};

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(opts.env || {}),
    },
  });
  if (res.status !== 0 && !opts.allowFail) {
    process.stderr.write(res.stdout || '');
    process.stderr.write(res.stderr || '');
    fail(`${cmd} ${args.join(' ')} failed (exit ${res.status})`);
  }
  return res;
}

function fail(msg) {
  console.error(`\n${C.red('✖ rollback aborted')} — ${msg}\n`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`\n${C.dim(`⚠ ${msg}`)}\n`);
}

// Unset proxy so the Cloudflare API call and health probe reach the edge.
const NO_PROXY = {
  http_proxy: '',
  https_proxy: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  all_proxy: '',
  ALL_PROXY: '',
};

console.log(`${C.green('↺')} rollback  →  project=${project} branch=${branch} ref=${ref}`);

// 1) Temporary worktree at the target commit. Using a worktree (not `git
//    checkout`) leaves the current working tree untouched — the developer is
//    never surprised by an in-place checkout during a failed deploy.
const wt = mkdtempSync(join(tmpdir(), `tagnest-rollback-`));
const worktree = join(wt, 'src');
run('git', ['worktree', 'add', '--detach', worktree, ref]);

const done = () => {
  try {
    run('git', ['worktree', 'remove', '--force', worktree], { allowFail: true });
  } catch {
    /* best effort */
  }
  try {
    rmSync(wt, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

try {
  // 2) Baseline health of the live site (informational precondition).
  run('node', ['scripts/health-check.mjs', `--base=${base}`, `--retries=1`, `--interval=1000`], {
    cwd: worktree,
    env: NO_PROXY,
    allowFail: true,
  });

  // 3) Install + build at the target commit.
  run('npm', ['ci'], { cwd: worktree });
  run('npm', ['run', 'build'], {
    cwd: worktree,
    env: { ...NO_PROXY, TN_KEEP_DIST: '1' },
    allowFail: false,
  });
  const dist = join(worktree, 'dist');
  if (!existsSync(join(dist, 'index.html'))) fail('dist/index.html missing after rebuild');

  // 4) Deploy to Pages.
  const cf = spawnSync(
    process.execPath,
    [join(worktree, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'pages', 'deploy', dist,
      `--project-name=${project}`, `--branch=${branch}`, '--commit-dirty=true'],
    { cwd: worktree, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, ...NO_PROXY } },
  );
  const cfOut = (cf.stdout || '') + (cf.stderr || '');
  if (cf.status !== 0) {
    process.stderr.write(cfOut);
    fail('Cloudflare Pages deploy failed');
  }
  const urlMatch = cfOut.match(/https:\/\/[a-z0-9]+\.\S+\.pages\.dev/);
  const deployUrl = urlMatch ? urlMatch[0] : `${branch}.${project}.pages.dev`;
  console.log(`deployed → ${deployUrl}`);

  // 5) Health-check the rollback deployment.
  run('node', ['scripts/health-check.mjs', `--base=${base}`, `--retries=8`, `--interval=8000`], {
    cwd: worktree,
    env: NO_PROXY,
    allowFail: false,
  });

  console.log(
    `${C.green('✓ rollback complete')} — ref ${ref} rebuilt, deployed to ${deployUrl}, health OK.`,
  );
  done();
  process.exit(0);
} catch (e) {
  done();
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}

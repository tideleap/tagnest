#!/usr/bin/env node
/**
 * TagNest release pipeline.
 *
 * One command takes a working tree from "edited" to "live on Cloudflare
 * Pages", running the same gates GitHub Actions would run. It exists so the
 * project has a reproducible deploy path that does not depend on the Actions
 * workflow being enabled — the CI files need a token with the `workflow`
 * scope, and this script needs nothing but a logged-in wrangler.
 *
 * Usage:
 *   node scripts/deploy.mjs                     # gates + build + deploy to main
 *   node scripts/deploy.mjs --branch=preview    # deploy to a preview branch
 *   node scripts/deploy.mjs --skip-checks       # build + deploy only
 *   node scripts/deploy.mjs --dry-run           # gates + build, no upload
 *   node scripts/deploy.mjs --push              # git push before deploying
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'tagnest';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const branch = option('branch', 'main');
const skipChecks = flag('skip-checks');
const skipBuild = flag('skip-build');
const dryRun = flag('dry-run');
const doPush = flag('push');

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

let step = 0;
const started = Date.now();

function heading(label) {
  step += 1;
  console.log(`\n${C.cyan(`▸ [${step}] ${label}`)}`);
}

function run(command, cmdArgs, { env, capture = false, allowFail = false } = {}) {
  const shown = `${command} ${cmdArgs.join(' ')}`;
  console.log(C.dim(`  $ ${shown}`));
  const result = spawnSync(command, cmdArgs, {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0 && !allowFail) {
    if (capture) {
      process.stderr.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    fail(`命令失败（exit ${result.status}）：${shown}`);
  }
  return result;
}

function fail(message) {
  console.error(`\n${C.red('✖ 部署中止')} — ${message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Pipeline
 * ------------------------------------------------------------------ */

console.log(C.bold(`\nTagNest deploy → Cloudflare Pages (${PROJECT}, branch=${branch})`));

heading('检查工作区');
{
  const status = run('git', ['status', '--porcelain'], { capture: true, allowFail: true });
  const dirty = (status.stdout ?? '').trim();
  if (dirty) {
    console.log(C.yellow('  工作区存在未提交改动，将以 --commit-dirty 部署：'));
    for (const line of dirty.split('\n').slice(0, 10)) console.log(C.dim(`    ${line}`));
  } else {
    console.log(C.dim('  clean'));
  }

  const head = run('git', ['rev-parse', '--short', 'HEAD'], { capture: true, allowFail: true });
  console.log(C.dim(`  HEAD = ${(head.stdout ?? '?').trim()}`));
}

if (doPush) {
  heading('推送到 origin');
  run('git', ['push', 'origin', 'HEAD']);
}

if (!skipChecks) {
  heading('类型检查');
  run('npm', ['run', 'typecheck']);

  heading('Lint');
  run('npm', ['run', 'lint']);

  heading('单元测试');
  run('npm', ['test']);
} else {
  console.log(C.yellow('\n  ⚠ 已跳过质量门禁（--skip-checks）'));
}

if (!skipBuild) {
  heading('生产构建');
  // TN_KEEP_DIST=1 keeps the build alive where a sandbox hook blocks the
  // recursive delete of dist. CI has no such hook and can override to ''.
  run('npm', ['run', 'build'], { env: { TN_KEEP_DIST: process.env.TN_KEEP_DIST ?? '1' } });

  const indexHtml = resolve(ROOT, 'dist/index.html');
  if (!existsSync(indexHtml)) fail('构建产物缺失：dist/index.html');

  const headers = resolve(ROOT, 'dist/_headers');
  if (!existsSync(headers)) {
    fail('构建产物缺失：dist/_headers —— 安全响应头不会生效，检查 public/_headers');
  }
  const headerText = readFileSync(headers, 'utf8');
  for (const required of ['Content-Security-Policy', 'Strict-Transport-Security']) {
    if (!headerText.includes(required)) fail(`dist/_headers 缺少 ${required}`);
  }
  console.log(C.dim('  产物校验通过（index.html + _headers）'));
}

if (dryRun) {
  console.log(`\n${C.green('✔ dry-run 完成')} — 未执行上传\n`);
  process.exit(0);
}

heading('部署到 Cloudflare Pages');
run('npx', [
  'wrangler',
  'pages',
  'deploy',
  'dist',
  `--project-name=${PROJECT}`,
  `--branch=${branch}`,
  '--commit-dirty=true',
]);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${C.green('✔ 部署完成')} ${C.dim(`(${seconds}s)`)}`);
console.log(
  C.dim(
    branch === 'main'
      ? '  生产地址：https://tagnest.pages.dev'
      : `  预览地址：https://${branch}.${PROJECT}.pages.dev`,
  ),
);
console.log('');

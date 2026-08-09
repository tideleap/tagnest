#!/usr/bin/env node
/**
 * setup-infra.mjs — idempotent Cloudflare infrastructure provisioning.
 *
 * This is the engine behind TagNest's "Deploy to Cloudflare" one-click flow.
 * When a user forks the repo and runs the Deploy workflow, this script brings
 * their *own* Cloudflare account to a working state with zero manual steps:
 *
 *   1. Creates the D1 database (if absent) and writes the new id back into
 *      wrangler.toml so the fork no longer points at the upstream database.
 *   2. Creates the R2 bucket (if absent) — used for website snapshots.
 *   3. Creates the KV namespace (if absent) — used for share-page edge cache.
 *   4. Generates a strong random JWT_SECRET and stores it as a Pages secret
 *      (only if one is not already set, so re-runs never invalidate sessions).
 *   5. Applies D1 migrations (idempotent — see scripts/migrate.mjs).
 *
 * Everything is a no-op when the resource already exists, so running this on
 * the upstream repo is safe: D1/KV ids match, the secret is already present,
 * and migrations are already applied — nothing is changed or torn down.
 *
 * Required credentials (set once as repo secrets by the user):
 *   CLOUDFLARE_API_TOKEN  — needs Pages:Edit, D1:Edit, R2:Edit, KV:Edit
 *   CLOUDFLARE_ACCOUNT_ID
 * Optional:
 *   CF_PAGES_PROJECT      — Pages project name (defaults to "tagnest")
 *
 * Usage:
 *   node scripts/setup-infra.mjs
 */

import { spawnSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_TOML = resolve(ROOT, 'wrangler.toml');
const WRANGLER_CLI = resolve(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const PROJECT = process.env.CF_PAGES_PROJECT || 'tagnest';
const D1_NAME = 'tagnest-db';
const R2_NAME = 'tagnest-media';
const KV_TITLE = 'SHARE_CACHE';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const cleanEnv = {
  ...process.env,
  http_proxy: '',
  https_proxy: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  all_proxy: '',
  ALL_PROXY: '',
};

function wrangler(args, { input, capture = false, allowFail = false } = {}) {
  const shown = `wrangler ${args.join(' ')}`;
  const piped = Boolean(input) || capture;
  if (!input) console.log(C.dim(`  $ ${shown}`));
  const res = spawnSync(process.execPath, [WRANGLER_CLI, ...args], {
    cwd: ROOT,
    stdio: piped ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: cleanEnv,
    input,
  });
  if (res.status !== 0 && !allowFail) {
    process.stderr.write(res.stdout ?? '');
    process.stderr.write(res.stderr ?? '');
    throw new Error(`wrangler 失败（exit ${res.status}）：${shown}`);
  }
  return res;
}

const firstUuid = (text) =>
  [...String(text).matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)]
    .map((m) => m[0])
    .find(Boolean);

const listJson = (args) => {
  const res = wrangler([...args, '--output', 'json'], { allowFail: true, capture: true });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : parsed?.result ?? parsed?.success ? parsed : [];
  } catch {
    return [];
  }
};

function step(label) {
  console.log(`\n${C.cyan(`▸ ${label}`)}`);
}

/* ------------------------------------------------------------------ *
 * 1. D1 database
 * ------------------------------------------------------------------ */
step('D1 数据库');
const d1List = listJson(['d1', 'list']);
const d1Existing = d1List.find((r) => r.name === D1_NAME);
let d1Id = d1Existing?.uuid || d1Existing?.id;

if (d1Id) {
  console.log(C.dim(`  已存在 ${D1_NAME} (${d1Id}) — 跳过创建`));
} else {
  console.log(`  创建 ${D1_NAME} …`);
  const res = wrangler(['d1', 'create', D1_NAME], { allowFail: true, capture: true });
  d1Id = firstUuid((res.stdout ?? '') + (res.stderr ?? ''));
  if (!d1Id) {
    console.log(C.red(`  ✗ 无法解析 ${D1_NAME} 的 id，终止。`));
    process.exit(1);
  }
  console.log(C.green(`  ✓ 已创建 ${D1_NAME} (${d1Id})`));
}

/* ------------------------------------------------------------------ *
 * 2. R2 bucket
 * ------------------------------------------------------------------ */
step('R2 存储桶（网站快照）');
const r2List = listJson(['r2', 'bucket', 'list']);
const r2Exists = r2List.some((r) => r.name === R2_NAME);
if (r2Exists) {
  console.log(C.dim(`  已存在 ${R2_NAME} — 跳过创建`));
} else {
  console.log(`  创建 ${R2_NAME} …`);
  const res = wrangler(['r2', 'bucket', 'create', R2_NAME], { allowFail: true });
  if (res.status !== 0) {
    console.log(
      C.yellow(`  ⚠ 创建 ${R2_NAME} 失败（R2 可能未在账户启用）。快照功能将降级，不影响主流程。`),
    );
  } else {
    console.log(C.green(`  ✓ 已创建 ${R2_NAME}`));
  }
}

/* ------------------------------------------------------------------ *
 * 3. KV namespace
 * ------------------------------------------------------------------ */
step('KV 命名空间（分享页缓存）');
const kvList = listJson(['kv', 'namespace', 'list']);
const kvExisting = kvList.find((r) => r.title === KV_TITLE);
let kvId = kvExisting?.id;
if (kvId) {
  console.log(C.dim(`  已存在 ${KV_TITLE} (${kvId}) — 跳过创建`));
} else {
  console.log(`  创建 ${KV_TITLE} …`);
  const res = wrangler(['kv', 'namespace', 'create', KV_TITLE, '--output', 'json'], {
    allowFail: true,
    capture: true,
  });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  kvId = firstUuid(out) || (() => { try { return JSON.parse(out).id; } catch { return undefined; } })();
  if (!kvId) {
    console.log(C.yellow(`  ⚠ 无法解析 ${KV_TITLE} 的 id，跳过（分享缓存将不可用）。`));
  } else {
    console.log(C.green(`  ✓ 已创建 ${KV_TITLE} (${kvId})`));
  }
}

/* ------------------------------------------------------------------ *
 * 4. Persist ids back into wrangler.toml (fork-safe)
 * ------------------------------------------------------------------ */
if (d1Id || kvId) {
  step('写回 wrangler.toml');
  let toml = readFileSync(WRANGLER_TOML, 'utf8');
  const original = toml;
  if (d1Id) {
    toml = toml.replace(/^database_id = ".*"$/m, `database_id = "${d1Id}"`);
  }
  if (kvId) {
    toml = toml.replace(/^id = ".*"$/m, `id = "${kvId}"`);
  }
  if (toml !== original) {
    writeFileSync(WRANGLER_TOML, toml);
    console.log(C.green('  ✓ 已更新 wrangler.toml 中的 database_id / KV id'));
    if (process.env.GITHUB_ACTIONS) {
      execSync('git config user.email "deploy@users.noreply.github.com"', { cwd: ROOT });
      execSync('git config user.name "TagNest Deploy"', { cwd: ROOT });
      execSync('git add wrangler.toml', { cwd: ROOT });
      execSync('git commit -m "chore(infra): 写入本仓库的 D1/KV 绑定 id [skip ci]"', { cwd: ROOT });
      console.log(C.dim('  已提交更新后的 wrangler.toml 到仓库'));
    }
  } else {
    console.log(C.dim('  无需更改'));
  }
}

/* ------------------------------------------------------------------ *
 * 5. JWT secret (only if not already set)
 * ------------------------------------------------------------------ */
step('JWT 密钥');
const secretRes = wrangler(['pages', 'secret', 'list', '--project-name', PROJECT, '--remote'], {
  allowFail: true,
  capture: true,
});
const secretOut = (secretRes.stdout ?? '') + (secretRes.stderr ?? '');
const alreadyHasJwt = /JWT_SECRET/i.test(secretOut);

if (alreadyHasJwt) {
  console.log(C.dim('  JWT_SECRET 已存在 — 跳过生成（不覆盖以免使现有会话失效）'));
} else {
  const secret = randomBytes(48).toString('base64url');
  console.log('  生成随机 JWT_SECRET 并写入 Pages 密钥 …');
  const put = wrangler(['pages', 'secret', 'put', 'JWT_SECRET', '--project-name', PROJECT, '--remote'], {
    input: `${secret}\n`,
    allowFail: true,
  });
  if (put.status !== 0) {
    console.log(C.red('  ✗ 写入 JWT_SECRET 失败，请稍后手动执行 `wrangler pages secret put JWT_SECRET`。'));
    process.exit(1);
  }
  console.log(C.green('  ✓ JWT_SECRET 已自动配置'));
}

/* ------------------------------------------------------------------ *
 * 6. Migrations (idempotent)
 * ------------------------------------------------------------------ */
step('D1 数据库迁移');
{
  const res = spawnSync(process.execPath, [resolve(ROOT, 'scripts', 'migrate.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    encoding: 'utf8',
    env: cleanEnv,
  });
  if (res.status !== 0) {
    process.stderr.write(res.stderr ?? '');
    throw new Error(`迁移失败（exit ${res.status}）`);
  }
}

console.log(`\n${C.green('✔ 基础设施就绪')} ${C.dim(`(project=${PROJECT})`)}\n`);

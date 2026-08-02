#!/usr/bin/env node
/**
 * Applies D1 migrations file-by-file against the remote database — the
 * reliable path for TagNest's schema.
 *
 * Why not `wrangler d1 migrations apply`?
 *   wrangler's `migrations apply` fatally mis-parses our multi-statement files
 *   that start with comments / FTS5 virtual tables / triggers and dies with
 *   "SQL code did not contain a statement". Executing each migration file
 *   individually with `d1 execute --file` sidesteps that, and every schema
 *   file is written idempotently (`CREATE ... IF NOT EXISTS`), so running any
 *   file again is a no-op and safe.
 *
 * Bookkeeping: applied migrations are recorded in `_d1_migrations(name,
 * applied_at)`. Any file already recorded is skipped, making the whole run
 * idempotent and restartable mid-way.
 *
 * Usage:
 *   node scripts/migrate.mjs              # apply all pending to remote
 *   node scripts/migrate.mjs --local      # apply to the local dev D1
 *   node scripts/migrate.mjs --dry-run    # list what would run, don't touch
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = resolve(ROOT, 'migrations');
const DB = 'tagnest-db';

const flag = (name) => process.argv.slice(2).includes(`--${name}`);
const local = flag('local');
const dryRun = flag('dry-run');

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS _d1_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

// Migrations applied historically via `wrangler d1 execute` (already recorded
// in _d1_migrations) are picked up by the same table, so nothing is re-run.
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^0\d+_[^.]+\.sql$/.test(f))
  .sort();

if (files.length === 0) {
  console.log('没有可应用的迁移文件');
  process.exit(0);
}

console.log(`目标数据库：${DB}（${local ? 'local' : 'remote'}）`);
console.log(`发现 ${files.length} 个迁移文件：`);
for (const f of files) console.log(`  - ${f}`);

if (dryRun) {
  console.log('\n--dry-run：未做任何修改');
  process.exit(0);
}

const run = (args) => {
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', DB, ...(local ? ['--local'] : ['--remote']), ...args], {
    cwd: ROOT,
    stdio: 'pipe',
    shell: process.platform === 'win32',
    encoding: 'utf8',
    env: {
      ...process.env,
      // Unset any local proxy so remote metadata calls don't hang.
      ...(local ? {} : { http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', all_proxy: '', ALL_PROXY: '' }),
    },
  });
  if (res.status !== 0) {
    process.stderr.write(res.stdout ?? '');
    process.stderr.write(res.stderr ?? '');
    throw new Error(`wrangler 失败（exit ${res.status}）`);
  }
  return res.stdout ?? '';
};

// Ensure the bookkeeping table exists (idempotent).
run(['--command', MIGRATIONS_TABLE]);

// Read already-applied names.
const appliedOut = run(['--command', `SELECT name FROM _d1_migrations`]);
const applied = new Set(
  [...appliedOut.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]),
);

let count = 0;
for (const file of files) {
  const path = resolve(MIGRATIONS_DIR, file);
  if (applied.has(file)) {
    console.log(`skip   ${file}（已应用）`);
    continue;
  }
  if (!existsSync(path)) {
    console.error(`missing ${file}`);
    process.exitCode = 1;
    continue;
  }
  const sql = readFileSync(path, 'utf8').trim();
  if (!sql) {
    console.log(`skip   ${file}（空文件）`);
    continue;
  }
  console.log(`apply  ${file} …`);
  try {
    run(['--file', path]);
    run(['--command', `INSERT OR IGNORE INTO _d1_migrations (name) VALUES ('${file.replace(/'/g, "''")}')`]);
    count += 1;
  } catch (e) {
    console.error(`   ✗ ${file} 失败：${e.message}`);
    console.error('  迁移中止。修复后重跑本脚本（已应用的会跳过）。');
    process.exit(1);
  }
}

console.log(`\n完成：新应用 ${count} 个；跳过已应用 ${files.length - count} 个。`);
if (count > 0 && !local) {
  console.log('提示：部署内容已就绪，任何迁移都在 push 后在 GitHub Actions 中自动执行。');
}

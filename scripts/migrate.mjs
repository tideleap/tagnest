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

// Normalise whitespace inside an inline `--command` SQL string so it is safe to
// pass as a single argument even when a value contains newlines / parentheses.
// All statements here contain no string literals whose inner spacing matters,
// so collapsing runs of whitespace to single spaces is lossless.
const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim();

const WRANGLER_CLI = resolve(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const run = (args) => {
  const sanitized = args.map((a, i) => (i > 0 && args[i - 1] === '--command' ? normalizeSql(a) : a));
  // Invoke the local wrangler CLI directly through node with `shell: false`.
  // Spawning `npx` (or wrangler) through a shell on Windows mangles argument
  // boundaries for `--command` values that contain spaces / parentheses,
  // splitting e.g. `CREATE TABLE IF NOT EXISTS …` into separate tokens. Passing
  // an explicit argv array to the node entry avoids ALL shell quoting.
  const res = spawnSync(
    process.execPath,
    [WRANGLER_CLI, 'd1', 'execute', DB, ...(local ? ['--local'] : ['--remote']), ...sanitized],
    {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        // Unset any local proxy so remote metadata calls don't hang.
        ...(local ? {} : { http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', all_proxy: '', ALL_PROXY: '' }),
      },
    },
  );
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

// Post-flight check: every migration file must be recorded, otherwise a silent
// partial apply slipped through (e.g. a statement whose runtime outcome was
// uncertain). Exit non-zero so CI treats it as a real failure instead of
// shipping against an under-migrated schema.
const verifyOut = run(['--command', `SELECT name FROM _d1_migrations`]);
const verified = new Set(
  [...verifyOut.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]),
);
const missing = files.filter((f) => !verified.has(f));
if (missing.length > 0) {
  console.error(`✗ 校验失败：以下迁移未登记：${missing.join(', ')}`);
  process.exit(1);
}
console.log(`✓ 校验通过：${files.length}/${files.length} 个迁移均已登记。`);

if (count > 0 && !local) {
  console.log('提示：部署内容已就绪，任何迁移都在 push 后在 GitHub Actions 中自动执行。');
}

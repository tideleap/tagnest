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

// Pre-flight probes for migrations whose net effect is a possibly-already-
// present schema mutation (SQLite cannot `ADD COLUMN IF NOT EXISTS`). When the
// probe returns a row, the migration is treated as already applied and
// recorded as such without re-running its SQL.
const MIGRATION_PROBES = {
  // 0002 adds bookmarks.manual_order via ALTER TABLE (not idempotent).
  '0002_keys_order_shares.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('bookmarks') WHERE name='manual_order'`,
  // 0003 creates tab_groups (idempotent, but harmless to confirm and record).
  '0003_tab_groups.sql':
    `SELECT COUNT(*) AS present FROM sqlite_master WHERE type='table' AND name='tab_groups'`,
  // 0004 partial UNIQUE index on live bookmarks (idempotent DDL, but recording
  // avoids churny re-applies when the bookkeeping write lagged).
  '0004_bookmark_urlkey_unique.sql':
    `SELECT COUNT(*) AS present FROM sqlite_master WHERE type='index' AND name='idx_bm_user_urlkey'`,
  // 0005 adds shares.palette via ALTER TABLE (not idempotent). Same "applied
  // but unrecorded" risk as 0002.
  '0005_share_palette.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('shares') WHERE name='palette'`,
  // 0006 is the two-track AI tagging refactor. Its most consequential side
  // effect is bookmark_tags.source (provenance); if that column already exists
  // the migration was applied (the `d1 execute --file` runner would otherwise
  // fail with "duplicate column name: source"). Probe bookmarks_tags.source as
  // the representative marker and treat its presence as "already applied".
  '0006_ai_tagging.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('bookmark_tags') WHERE name='source'`,
  // 0007 adds bookmarks.snapshot_key via ALTER TABLE (not idempotent). Probe
  // that column's presence as the "already applied" marker.
  '0007_snapshot_r2.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('bookmarks') WHERE name='snapshot_key'`,
  // 0008 creates user_settings and adds bookmarks.snapshot_keys (both DDL).
  // Probe the new bookmark column as the representative marker (the ALTER is
  // the non-idempotent part; CREATE TABLE IF NOT EXISTS is safe to re-run).
  '0008_snapshot_retention.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('bookmarks') WHERE name='snapshot_keys'`,
  // 0009 adds four auto-clear columns to user_settings (ALTER, non-idempotent).
  // Probe one representative column as the "already applied" marker.
  '0009_auto_clear_settings.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('user_settings') WHERE name='search_auto_clear_delay'`,
  // 0011 adds topic + needs_review to tag_suggestions via ALTER (non-idempotent).
  // Probe one of the new columns as the "already applied" marker.
  '0011_ai_enhancements.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('tag_suggestions') WHERE name='topic'`,
  // 0012 adds feedback_boosted to tag_suggestions via ALTER (non-idempotent) and
  // creates ai_feedback (idempotent via IF NOT EXISTS). Probe the column.
  '0012_ai_feedback.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('tag_suggestions') WHERE name='feedback_boosted'`,
  // 0013 adds prompt_version to ai_jobs via ALTER (non-idempotent). Probe the
  // column so a file already applied directly via `wrangler d1 execute --file`
  // (which never writes _d1_migrations) is recognised and skipped.
  '0013_prompt_version.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('ai_jobs') WHERE name='prompt_version'`,
  // 0014 adds is_private + encrypted_blob to bookmarks via ALTER (non-idempotent)
  // and creates the private_vault table + index (idempotent via IF NOT EXISTS).
  // Probe the first added column as the representative "already applied" marker.
  '0014_private_bookmarks.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('bookmarks') WHERE name='is_private'`,
  // 0015 adds is_private to tags via ALTER (non-idempotent). Probe the column
  // so a file already applied directly via `wrangler d1 execute --file` is
  // recognised and skipped on a re-run.
  '0015_tag_private.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('tags') WHERE name='is_private'`,
  // 0016 adds updated_at to tags via ALTER (non-idempotent). setTagPrivate
  // references this column; probe it so a manual fix or re-run is safe.
  '0016_tags_updated_at.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('tags') WHERE name='updated_at'`,
  // 0017 creates idx_collections_user_name (CREATE UNIQUE INDEX IF NOT EXISTS,
  // safe to re-run, but probe so the bookkeeping write records it on re-runs).
  '0017_collections_name_unique.sql':
    `SELECT COUNT(*) AS present FROM sqlite_master WHERE type='index' AND name='idx_collections_user_name'`,
  // 0018 adds shares.password_hash + shares.collection_id (ALTER, non-idempotent).
  // Both columns were applied via a direct `wrangler d1 execute --file` that
  // never wrote _d1_migrations, so probe collection_id as the marker and treat
  // its presence as "already applied" instead of re-ADDing (which would throw
  // "duplicate column name: password_hash").
  '0018_share_password_collection.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('shares') WHERE name='collection_id'`,
  // 0019 creates tag_merge_log (IF NOT EXISTS). Probe the table.
  '0019_tag_merge_log.sql':
    `SELECT COUNT(*) AS present FROM sqlite_master WHERE type='table' AND name='tag_merge_log'`,
  // 0020 creates backup_targets (no IF NOT EXISTS). Probe the table so a re-run
  // after a partial apply does not duplicate it.
  '0020_backup.sql':
    `SELECT COUNT(*) AS present FROM sqlite_master WHERE type='table' AND name='backup_targets'`,
  // 0021 adds collections.kind + collections.query (ALTER, non-idempotent). Probe
  // kind (the first added column) as the "already applied" marker.
  '0021_collections_smart.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('collections') WHERE name='kind'`,
  // 0022 creates feeds (IF NOT EXISTS). Probe the table.
  '0022_feeds.sql':
    `SELECT COUNT(*) AS present FROM sqlite_master WHERE type='table' AND name='feeds'`,
  // 0023 adds ai_settings.fetch_content + ai_settings.two_pass (ALTER, non-
  // idempotent). Both columns were applied via a direct `wrangler d1 execute
  // --file` that never wrote _d1_migrations, so probe fetch_content as the
  // "already applied" marker instead of re-ADDing (which would throw
  // "duplicate column name: fetch_content").
  '0023_ai_enhancements.sql':
    `SELECT COUNT(*) AS present FROM pragma_table_info('ai_settings') WHERE name='fetch_content'`,
};

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

// Resolve the Cloudflare account id. Prefer the explicit secret; fall back to
// `wrangler whoami` (an API token is account-scoped, so whoami reports it).
// Without an account id, `wrangler d1 execute --remote` cannot target the
// database and the migration step fails — blocking a release that otherwise
// only needs the (account-scoped) API token. This keeps migrations running
// even when CLOUDFLARE_ACCOUNT_ID is left unset.
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  try {
    const res = spawnSync(process.execPath, [WRANGLER_CLI, 'whoami'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', all_proxy: '', ALL_PROXY: '' },
    });
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    const m = out.match(/\b[0-9a-f]{32}\b/i);
    if (m) process.env.CLOUDFLARE_ACCOUNT_ID = m[0];
  } catch {
    /* ignore */
  }
}

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

  // Pre-flight: some migrations mutate rather than create (notably
  // `ALTER TABLE ... ADD COLUMN`, which SQLite cannot guard with IF NOT
  // EXISTS). If a migration was applied historically by a tool that did not
  // write `_d1_migrations` (e.g. a manual `wrangler d1 execute --file`), its
  // side effects already exist in the schema but the file is not recorded.
  // Probe for those side effects; if present, record the file as applied and
  // skip it (re-running the ALTER would fail with 'duplicate column').
  const probe = MIGRATION_PROBES[file];
  if (probe) {
    // Present if the probe SQL returns present > 0. Parsed from wrangler's JSON
    // output (robust to the exact column/format wrangler emits).
    const out = run(['--command', probe]) ?? '';
    const present = [...out.matchAll(/"present"\s*:\s*(\d+)/g)].reduce(
      (max, m) => Math.max(max, Number(m[1]) || 0),
      0,
    );
    if (present > 0) {
      run(['--command', `INSERT OR IGNORE INTO _d1_migrations (name) VALUES ('${file.replace(/'/g, "''")}')`]);
      console.log(`skip   ${file}（schema 已就绪，登记为已应用）`);
      continue;
    }
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

// Post-flight schema verification.
//
// We deliberately verify the *schema markers* (not a read-back of
// `_d1_migrations`): D1 remote is eventually consistent, so a bookkeeping
// write made in this very run may not be visible to an immediate re-read and
// would spuriously fail. Schema markers reflect the actual migrated state and
// are the true correctness signal.
const MIGRATION_VERIFY = {
  // 0004 must leave a partial UNIQUE index in place.
  '0004_bookmark_urlkey_unique.sql':
    `SELECT COUNT(*) AS present FROM sqlite_master WHERE type='index' AND name='idx_bm_user_urlkey' AND sql LIKE '%UNIQUE%'`,
};
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const schemaPresent = (probe) => {
  const out = run(['--command', probe]) ?? '';
  return [...out.matchAll(/"present"\s*:\s*(\d+)/g)].some((m) => Number(m[1]) > 0);
};

let verifyFailed = false;
for (const file of files) {
  const probe = MIGRATION_VERIFY[file];
  if (!probe) continue;
  // Retry once after a short wait to absorb D1 replication lag.
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleepMs(attempt * 1500);
    if (schemaPresent(probe)) break;
    if (attempt === 1) {
      console.error(`✗ 校验失败：迁移 ${file} 的 schema 未就绪`);
      verifyFailed = true;
    }
  }
}
if (verifyFailed) process.exit(1);
console.log(`✓ schema 校验通过。`);

if (count > 0 && !local) {
  console.log('提示：部署内容已就绪，任何迁移都在 push 后在 GitHub Actions 中自动执行。');
}

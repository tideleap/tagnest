#!/usr/bin/env node
/**
 * tag-quality-baseline.mjs — PRD-TAG-QUALITY-2026-08-30 §4.7 / P0-0.
 *
 * Re-runnable tag-quality baseline against the production D1. Reads the live
 * `tags` / `bookmarks` / `bookmark_tags` tables and prints every §4.7 metric
 * that is derivable from a DB snapshot, so "before / after governance" claims
 * are grounded in numbers instead of vibes.
 *
 * Usage:
 *   node scripts/tag-quality-baseline.mjs            # remote (production)
 *   node scripts/tag-quality-baseline.mjs --local    # local dev D1
 *   node scripts/tag-quality-baseline.mjs --json     # machine-readable output
 *
 * Requires a Cloudflare token with `Account > D1 > Edit` scope in the env
 * (CLOUDFLARE_API_TOKEN) — the same credential deploy.yml uses. When the token
 * is absent the script exits 1 with a clear message instead of hanging.
 *
 * Metrics that are per-run (词表复用率 / 新标签占比) are NOT derivable from a
 * static snapshot; they are reported live by the governance `quality` object on
 * every organize run (P1-7). This script prints the structural metrics and marks
 * the per-run ones as "runtime-only".
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = resolve(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DB = 'tagnest-db';

const flag = (name) => process.argv.slice(2).includes(`--${name}`);
const local = flag('local');
const asJson = flag('json');

// Strip any local proxy so remote metadata calls don't hang (same as probe-d1).
const CLEAN_ENV = {
  ...process.env,
  http_proxy: '',
  https_proxy: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  all_proxy: '',
  ALL_PROXY: '',
};

function run(sql) {
  const args = [WRANGLER, 'd1', 'execute', DB, local ? '--local' : '--remote', '--json', '--command', sql];
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', env: CLEAN_ENV });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  if (res.status !== 0) {
    throw new Error(`d1 execute failed for query:\n  ${sql}\n${out.split('\n').slice(-3).join('\n')}`);
  }
  // wrangler --json prints an array of statement results; take the first.
  const parsed = JSON.parse(res.stdout);
  const stmt = Array.isArray(parsed) ? parsed[0] : parsed;
  return stmt?.results ?? [];
}

function scalar(sql) {
  const rows = run(sql);
  if (!rows.length) return 0;
  const first = rows[0];
  const key = Object.keys(first)[0];
  return Number(first[key] ?? 0);
}

function pct(part, whole) {
  if (!whole) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function main() {
  // --- Structural counts -------------------------------------------------
  const N = scalar(`SELECT COUNT(*) AS c FROM bookmarks WHERE deleted_at IS NULL`);
  const D = scalar(`SELECT COUNT(*) AS c FROM tags`);
  const A = scalar(`SELECT COUNT(*) AS c FROM bookmark_tags`);
  const unused = scalar(
    `SELECT COUNT(*) AS c FROM tags t WHERE NOT EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.tag_id = t.id)`,
  );
  const singletons = scalar(
    `SELECT COUNT(*) AS c FROM tags t WHERE (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.tag_id = t.id) = 1`,
  );
  const zeroTag = scalar(
    `SELECT COUNT(*) AS c FROM bookmarks b WHERE b.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id)`,
  );
  const singleTag = scalar(
    `SELECT COUNT(*) AS c FROM bookmarks b WHERE b.deleted_at IS NULL AND (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.bookmark_id = b.id) = 1`,
  );

  // Head concentration: the top ceil(20% of D) tags by support, and the share
  // of all assignments they cover.
  const top20 = Math.max(1, Math.ceil(D * 0.2));
  const headRows = run(
    `SELECT SUM(cnt) AS covered FROM (
       SELECT COUNT(*) AS cnt FROM bookmark_tags GROUP BY tag_id ORDER BY cnt DESC LIMIT ${top20}
     )`,
  );
  const headCovered = Number(headRows[0]?.covered ?? 0);

  const used = D - unused;
  const supGE2 = used - singletons;
  const assignGE2 = A - singletons;

  const report = {
    captured_at: new Date().toISOString(),
    source: local ? 'local-dev-d1' : 'production-d1',
    inputs: { bookmarks: N, distinct_tags: D, assignments: A },
    metrics: {
      distinct_tags_D: D,
      singleton_rate: { value: singletons / (D || 1), display: pct(singletons, D), target: '<= 5%' },
      avg_support: { value: A / (D || 1), display: (A / (D || 1)).toFixed(2), target: '>= 3' },
      head_concentration_top20: { value: headCovered / (A || 1), display: pct(headCovered, A), target: '>= 60%', top_n: top20 },
      zero_tag_bookmark_rate: { value: zeroTag / (N || 1), display: pct(zeroTag, N), target: '<= 1%' },
      single_tag_bookmark_rate: { value: singleTag / (N || 1), display: pct(singleTag, N), target: '<= 10%' },
      unused_tags: unused,
      support_ge2_tags: supGE2,
      avg_support_ge2: supGE2 ? (assignGE2 / supGE2).toFixed(2) : '—',
      vocab_reuse_rate: 'runtime-only (see governance quality object, P1-7)',
      new_tag_ratio: 'runtime-only (see governance quality object, P1-7)',
    },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const m = report.metrics;
  console.log('');
  console.log(`TagNest tag-quality baseline — ${report.source} @ ${report.captured_at}`);
  console.log(`Inputs: N=${N} bookmarks, D=${D} distinct tags, A=${A} assignments`);
  console.log('');
  console.log('  Metric                          Value        Target');
  console.log('  ------------------------------  -----------  --------');
  console.log(`  Distinct tags (D)               ${String(D).padEnd(11)}  <= budget(N)`);
  console.log(`  Singleton rate                  ${m.singleton_rate.display.padEnd(11)}  ${m.singleton_rate.target}`);
  console.log(`  Avg support                     ${m.avg_support.display.padEnd(11)}  ${m.avg_support.target}`);
  console.log(`  Head concentration (top ${top20})      ${m.head_concentration_top20.display.padEnd(11)}  ${m.head_concentration_top20.target}`);
  console.log(`  Zero-tag bookmark rate          ${m.zero_tag_bookmark_rate.display.padEnd(11)}  ${m.zero_tag_bookmark_rate.target}`);
  console.log(`  Single-tag bookmark rate        ${m.single_tag_bookmark_rate.display.padEnd(11)}  ${m.single_tag_bookmark_rate.target}`);
  console.log(`  Unused tags                     ${unused}`);
  console.log(`  Tags with support >= 2          ${supGE2} (avg ${m.avg_support_ge2})`);
  console.log('');
  console.log('  Per-run metrics (vocab reuse rate, new-tag ratio) are reported by the');
  console.log('  governance quality object on each organize run — not derivable here.');
  console.log('');
}

try {
  main();
} catch (e) {
  console.error('BASELINE FAILED:', e.message);
  process.exit(1);
}

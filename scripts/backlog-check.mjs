#!/usr/bin/env node
/**
 * Backlog consistency checker.
 *
 * The ledger in `docs/backlog.json` claims a status for every requirement.
 * This script re-derives that status from the repository itself and fails when
 * the claim and the evidence disagree — in *either* direction:
 *
 *   - a "done" item whose evidence no longer holds  -> regression / false claim
 *   - an "open" item whose evidence fully holds     -> shipped but never logged
 *
 * Both directions matter. The first catches documentation drift, the second
 * catches work that quietly falls off the queue, which is how "remaining
 * requirements" go missing in the first place.
 *
 * Usage:
 *   node scripts/backlog-check.mjs           # verify (exit 1 on mismatch)
 *   node scripts/backlog-check.mjs --write   # refresh the table in docs/BACKLOG.md
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(root, 'docs', 'backlog.json');
const DOC = join(root, 'docs', 'BACKLOG.md');
const BEGIN = '<!-- BEGIN:BACKLOG-TABLE -->';
const END = '<!-- END:BACKLOG-TABLE -->';

const WRITE = process.argv.includes('--write');

/** Statuses that are terminal by human decision rather than by code evidence. */
const EXEMPT = new Set(['superseded', 'blocked-external']);
const SATISFIED = new Set(['done', 'superseded']);

const read = (rel) => {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

/** Evaluate one probe. Returns { ok, label }. */
function probe(p) {
  switch (p.type) {
    case 'file':
      return { ok: existsSync(join(root, p.path)), label: `file:${p.path}` };
    case 'absent':
      return { ok: !existsSync(join(root, p.path)), label: `absent:${p.path}` };
    case 'grep': {
      const body = read(p.path);
      return {
        ok: body !== null && new RegExp(p.pattern).test(body),
        label: `grep:${p.path}~/${p.pattern}/`,
      };
    }
    case 'nogrep': {
      const body = read(p.path);
      return {
        ok: body !== null && !new RegExp(p.pattern).test(body),
        label: `nogrep:${p.path}~/${p.pattern}/`,
      };
    }
    case 'test':
      return {
        ok: existsSync(join(root, 'tests', `${p.name}.test.ts`)),
        label: `test:tests/${p.name}.test.ts`,
      };
    case 'mincount': {
      const [dir, pat] = p.glob.split('/');
      const rx = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      const abs = join(root, dir);
      const n = existsSync(abs) ? readdirSync(abs).filter((f) => rx.test(f)).length : 0;
      return { ok: n >= p.min, label: `mincount:${p.glob}>=${p.min} (found ${n})` };
    }
    default:
      return { ok: false, label: `unknown probe type: ${p.type}` };
  }
}

const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
const items = ledger.items;
const byId = new Map(items.map((i) => [i.id, i]));
const errors = [];
const rows = [];

// Pass 1: aliases. The same work is often described by two source documents
// (e.g. 03-优化清单 P1-6 and PM-REVIEW O11 are one job). Registering both keeps
// traceability, but only the canonical entry carries evidence and enters the
// queue; the alias mirrors its status so the two can never diverge.
for (const item of items) {
  if (!item.aliasOf) continue;
  const target = byId.get(item.aliasOf);
  if (!target) {
    errors.push(`${item.id}: aliasOf 指向不存在的需求 ${item.aliasOf}`);
    continue;
  }
  if (target.aliasOf) errors.push(`${item.id}: 不允许别名指向别名 (${item.aliasOf})`);
  item.status = target.status;
}

for (const item of items) {
  for (const field of ['id', 'title', 'source', 'priority', 'status']) {
    if (!item[field]) errors.push(`${item.id ?? '(no id)'}: 缺少必填字段 ${field}`);
  }
  if (item.aliasOf) {
    rows.push({
      id: item.id,
      title: item.title,
      priority: item.priority,
      status: item.status,
      evidence: `→ ${item.aliasOf}`,
      note: item.note ?? '',
    });
    continue;
  }
  if (!ledger.statuses[item.status]) {
    errors.push(`${item.id}: 非法状态 "${item.status}"`);
  }
  if (EXEMPT.has(item.status) && !item.note) {
    errors.push(`${item.id}: 状态 ${item.status} 必须给出 note 说明理由`);
  }

  const results = (item.evidence ?? []).map(probe);
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const allPass = total > 0 && passed === total;

  if (!EXEMPT.has(item.status)) {
    if (item.status === 'done' && total === 0) {
      // Some work leaves no trace in the repo (e.g. deleting rows from the
      // production database). Those may be closed on a written attestation,
      // but never silently.
      if (!item.note) {
        errors.push(`${item.id} 标记 done 但无证据探针，必须以 note 记录人工核验结论`);
      }
    } else if (item.status === 'done' && !allPass) {
      const missing = results.filter((r) => !r.ok).map((r) => r.label);
      errors.push(`${item.id} 标记 done 但证据不成立 -> ${missing.join(' | ')}`);
    }
    if (item.status === 'open' && allPass) {
      errors.push(`${item.id} 标记 open 但全部证据已成立 -> 疑似已完成未登记，请更新台账`);
    }
  }

  for (const dep of item.dependsOn ?? []) {
    const d = byId.get(dep);
    if (!d) errors.push(`${item.id}: 依赖了不存在的需求 ${dep}`);
    else if (item.status === 'done' && !SATISFIED.has(d.status)) {
      errors.push(`${item.id} 已完成，但其依赖 ${dep} 仍为 ${d.status}`);
    }
  }

  rows.push({
    id: item.id,
    title: item.title,
    priority: item.priority,
    status: item.status,
    evidence: total === 0 ? '人工核验' : `${passed}/${total}`,
    note: item.note ?? '',
  });
}

const MARK = {
  done: '✅ done',
  open: '⬜ open',
  superseded: '➖ superseded',
  'blocked-external': '⏸ blocked-external',
};

const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
const queue = items
  .filter((i) => i.status === 'open' && !i.aliasOf)
  .sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || a.id.localeCompare(b.id));

const canonical = items.filter((i) => !i.aliasOf);
const counts = canonical.reduce((acc, i) => ((acc[i.status] = (acc[i.status] ?? 0) + 1), acc), {});
const summary =
  `> 自动生成于 \`npm run backlog:write\`，请勿手动编辑本区块。\n` +
  `> 登记 ${items.length} 条（其中 ${items.length - canonical.length} 条为跨文档别名），` +
  `独立需求 ${canonical.length} 项：` +
  Object.entries(counts)
    .map(([k, v]) => `${MARK[k] ?? k} ${v}`)
    .join(' ／ ') +
  `\n`;

const table = [
  '| 编号 | 需求 | 优先级 | 状态 | 证据 | 备注 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map(
    (r) =>
      `| \`${r.id}\` | ${r.title} | ${r.priority} | ${MARK[r.status] ?? r.status} | ${r.evidence} | ${r.note} |`,
  ),
].join('\n');

const queueBlock = queue.length
  ? '\n**当前执行队列**（按优先级与依赖拓扑排序）：\n\n' +
    queue.map((i, n) => `${n + 1}. \`${i.id}\` ${i.title}（${i.priority}）`).join('\n') +
    '\n'
  : '\n**当前执行队列**：空 —— 所有需求已进入终态。\n';

const block = `${BEGIN}\n\n${summary}\n${table}\n${queueBlock}\n${END}`;

const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : null;
if (doc === null) {
  errors.push('docs/BACKLOG.md 不存在');
} else if (!doc.includes(BEGIN) || !doc.includes(END)) {
  errors.push('docs/BACKLOG.md 缺少 BACKLOG-TABLE 标记区块');
} else {
  const next = doc.slice(0, doc.indexOf(BEGIN)) + block + doc.slice(doc.indexOf(END) + END.length);
  if (next !== doc) {
    if (WRITE) {
      writeFileSync(DOC, next);
      console.log('docs/BACKLOG.md 状态表已刷新');
    } else {
      errors.push('docs/BACKLOG.md 状态表已过期，请运行 `npm run backlog:write`');
    }
  }
}

if (errors.length) {
  console.error(`\n需求台账校验失败（${errors.length} 处）：\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  process.exit(1);
}

const open = counts.open ?? 0;
console.log(
  `需求台账一致 ✓  ${items.length} 项 / 待办 ${open} 项` +
    (queue.length ? ` / 下一项 ${queue[0].id} ${queue[0].title}` : ''),
);

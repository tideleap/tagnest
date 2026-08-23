// TagNest bidirectional sync page controller (B-12, Phase B).
//
// Talks to the background worker (which owns chrome.bookmarks) via messages.
// Owns no browser-tree reads itself — it only renders state and triggers the
// sync/rollback intents. Conflict resolution "采用 TagNest" is performed here
// locally from the TN item captured in the sync result, so no extra round-trip
// is needed.

import { loadConfig, isConfigured } from './bg/config.js';
import { loadSyncState } from './bg/reconcile.js';
import { clear, el } from './dom.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusText: $('statusText'),
  direction: $('direction'),
  dirHint: $('dirHint'),
  startSync: $('startSync'),
  progress: $('progress'),
  progressText: $('progressText'),
  result: $('result'),
  conflicts: $('conflicts'),
  conflictCount: $('conflictCount'),
  conflictList: $('conflictList'),
  categoryConflicts: $('categoryConflicts'),
  categoryConflictCount: $('categoryConflictCount'),
  categoryConflictList: $('categoryConflictList'),
  rollbackPanel: $('rollbackPanel'),
  rollbackBtn: $('rollbackBtn'),
  openCategoryBuild: $('openCategoryBuild'),
  openReconcile: $('openReconcile'),
  openOptions: $('openOptions'),
};

let direction = 'upload';

function baseHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function reflectStatus() {
  const cfg = await loadConfig();
  if (isConfigured(cfg)) {
    els.status.hidden = false;
    els.status.className = 'status';
    els.statusText.textContent = `已连接 ${baseHost(cfg.baseUrl)}`;
  } else {
    els.status.hidden = false;
    els.status.className = 'status warn';
    els.statusText.textContent = '尚未配置服务器与密钥';
  }

  const state = await loadSyncState().catch(() => ({ lastSyncedAt: '' }));
  if (state.lastSyncedAt) {
    els.dirHint.append(document.createTextNode(` 上次同步：${new Date(state.lastSyncedAt).toLocaleString()}`));
  }
}

async function hasBookmarksPermission() {
  try {
    return Boolean(await chrome.permissions.contains({ permissions: ['bookmarks'] }));
  } catch {
    return false;
  }
}

els.direction.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  direction = btn.dataset.dir;
  els.direction.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  els.dirHint.textContent =
    direction === 'two-way'
      ? '双向：把 TagNest 的变更写回书签栏的「TagNest」文件夹（浏览器书签无标签字段，仅标题会被写回）。'
      : '仅上传：把浏览器书签推送到 TagNest（默认，最安全，不会改动浏览器书签）。';
});

els.startSync.addEventListener('click', async () => {
  els.result.hidden = true;
  els.conflicts.hidden = true;
  els.categoryConflicts.hidden = true;
  els.rollbackPanel.hidden = true;
  els.progress.hidden = false;
  els.progressText.textContent = '同步中…';
  els.startSync.disabled = true;

  try {
    // Both directions read the browser tree, so the bookmarks permission is required.
    if (!(await hasBookmarksPermission())) {
      const granted = await chrome.permissions
        .request({ permissions: ['bookmarks'] })
        .catch(() => false);
      if (!granted) {
        els.progress.hidden = true;
        els.startSync.disabled = false;
        renderError('需要「书签」权限才能读取浏览器书签树');
        return;
      }
    }

    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'run-sync', direction }, resolve);
    });
    if (!resp) {
      renderError('扩展后台未响应，请重新打开扩展');
      return;
    }
    if (!resp.ok) {
      if (resp.notConfigured) renderError('请先在设置中配置服务器与密钥');
      else renderError(resp.message || '同步失败');
      return;
    }
    renderResult(resp);
  } catch (err) {
    renderError(err?.message || '同步失败');
  } finally {
    els.progress.hidden = true;
    els.startSync.disabled = false;
  }
});

function renderError(message) {
  els.result.hidden = false;
  els.result.className = 'result err';
  clear(els.result);
  els.result.append(el('h2', 'head', '同步未完成'));
  els.result.append(el('div', 'err', message));
}

function renderResult(resp) {
  const p = resp.pushed || { applied: 0, failed: 0, errors: [] };
  const a = resp.applied || { created: 0, updated: 0, removed: 0, moved: 0 };
  const cs = resp.categoryStats || { pushed: 0, appliedMoves: 0, appliedCreates: 0, conflicts: 0 };
  els.result.hidden = false;
  els.result.className = 'result ok';
  clear(els.result);
  const addRow = (label, value) => {
    const row = el('div', 'row');
    row.append(el('span', null, label));
    row.append(el('b', null, String(value)));
    els.result.append(row);
  };
  els.result.append(
    el('h2', 'head', `同步完成（${direction === 'two-way' ? '双向' : '仅上传'}）`),
  );
  addRow('浏览器书签', resp.browserCount);
  addRow('TagNest 变更', resp.tnCount);
  addRow('已上传 / 失败', `${p.applied} / ${p.failed}`);
  if (direction === 'two-way') {
    addRow('写回浏览器（建/改/删）', `${a.created} / ${a.updated} / ${a.removed}`);
  }
  // 分类同步统计（CS-P3-5）
  addRow('分类上行（本地文件夹 → 云端）', cs.pushed);
  if (direction === 'two-way') {
    addRow('分类写回（云端 → 本地文件夹移动）', a.moved || 0);
    addRow('新建书签带分类落位', cs.appliedCreates);
  }
  if (p.failed > 0 && Array.isArray(p.errors)) {
    const errText = `失败明细：${p.errors
      .slice(0, 5)
      .map((e) => `#${e.index} ${e.code}`)
      .join('，')}`;
    els.result.append(el('div', 'err', errText));
  }

  const conflicts = Array.isArray(resp.conflictDetails) ? resp.conflictDetails : [];
  const categoryConflicts = conflicts.filter((c) => c.reason === 'category_conflict');
  const generalConflicts = conflicts.filter((c) => c.reason !== 'category_conflict');

  if (generalConflicts.length) {
    els.conflicts.hidden = false;
    els.conflictCount.textContent = String(generalConflicts.length);
    renderConflicts(generalConflicts);
  }
  if (categoryConflicts.length) {
    els.categoryConflicts.hidden = false;
    els.categoryConflictCount.textContent = String(categoryConflicts.length);
    renderCategoryConflicts(categoryConflicts);
  }
  if (direction === 'two-way' && (a.created || a.updated || a.removed || a.moved)) {
    els.rollbackPanel.hidden = false;
  }
}

function renderConflicts(conflicts) {
  clear(els.conflictList);
  for (const c of conflicts) {
    const li = document.createElement('li');

    const key = document.createElement('div');
    key.className = 'key';
    key.textContent = c.urlKey;

    const reason = document.createElement('div');
    reason.className = 'reason';
    reason.textContent =
      c.reason === 'both_modified'
        ? '两侧都修改了同一书签'
        : c.reason === 'deleted_in_tagnest_but_modified_locally'
          ? 'TagNest 已删除，但浏览器侧有本地修改'
          : c.reason;

    const acts = document.createElement('div');
    acts.className = 'acts';

    const keepBtn = document.createElement('button');
    keepBtn.className = 'btn btn-secondary';
    keepBtn.textContent = '保留浏览器';
    keepBtn.addEventListener('click', () => {
      li.style.opacity = '0.5';
      keepBtn.disabled = true;
      applyBtn.disabled = true;
    });

    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-primary';
    applyBtn.textContent = '采用 TagNest';
    applyBtn.addEventListener('click', () => applyTagNestVersion(c, li, keepBtn, applyBtn));

    acts.append(keepBtn, applyBtn);
    li.append(key, reason, acts);
    els.conflictList.append(li);
  }
}

// Locally write TagNest's version of the conflicting bookmark into the browser.
async function applyTagNestVersion(c, li, keepBtn, applyBtn) {
  const tn = c.tn;
  if (!tn || !tn.url) {
    applyBtn.disabled = true;
    return;
  }
  try {
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0] && tree[0].children ? tree[0].children[0] : null;
    const folder =
      (bar.children || []).find((f) => f.url === undefined && f.title === 'TagNest') ||
      (await chrome.bookmarks.create({ parentId: bar.id, title: 'TagNest' }));
    await chrome.bookmarks.create({ parentId: folder.id, title: tn.title || '', url: tn.url });
    li.style.opacity = '0.5';
    keepBtn.disabled = true;
    applyBtn.disabled = true;
    applyBtn.textContent = '已采用';
  } catch {
    applyBtn.textContent = '写回失败';
  }
}

// --- Category conflict resolution (C4-4) ------------------------------------
// The local manual move already won upward (pushed). "保留本地文件夹" is a
// no-op acknowledgement; "采用云端分类" moves the managed bookmark into the
// cloud's category folder chain (creating folders as needed).

function renderCategoryConflicts(conflicts) {
  clear(els.categoryConflictList);
  for (const c of conflicts) {
    const li = document.createElement('li');

    const key = document.createElement('div');
    key.className = 'key';
    key.textContent = c.urlKey;

    const reason = document.createElement('div');
    reason.className = 'reason';
    const local = Array.isArray(c.localPath) && c.localPath.length ? c.localPath.join(' > ') : '（未分类）';
    const cloud = Array.isArray(c.cloudPath) && c.cloudPath.length ? c.cloudPath.join(' > ') : '（未分类）';
    reason.textContent = `本地文件夹：${local} ｜ 云端分类：${cloud}`;

    const acts = document.createElement('div');
    acts.className = 'acts';

    const keepBtn = document.createElement('button');
    keepBtn.className = 'btn btn-secondary';
    keepBtn.textContent = '保留本地文件夹';
    keepBtn.addEventListener('click', () => {
      li.style.opacity = '0.5';
      keepBtn.disabled = true;
      applyBtn.disabled = true;
      keepBtn.textContent = '已保留本地';
    });

    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-primary';
    applyBtn.textContent = '采用云端分类';
    applyBtn.addEventListener('click', () => applyCloudCategory(c, li, keepBtn, applyBtn));

    acts.append(keepBtn, applyBtn);
    li.append(key, reason, acts);
    els.categoryConflictList.append(li);
  }
}

/** Ensure a nested folder chain under `rootId`; returns the deepest id. */
async function ensureFolderChain(rootId, path) {
  let parentId = rootId;
  for (const seg of path || []) {
    const children = await chrome.bookmarks.getChildren(parentId).catch(() => []);
    const existing = (children || []).find((n) => n.url === undefined && n.title === seg);
    if (existing) {
      parentId = existing.id;
    } else {
      const created = await chrome.bookmarks.create({ parentId, title: seg });
      parentId = created.id;
    }
  }
  return parentId;
}

/** Find the first bookmark node under `root` whose url matches `url`. */
async function findBookmarkByUrl(root, url) {
  const walk = (node) => {
    if (node.url === url) return node;
    for (const child of node.children || []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  const [full] = await chrome.bookmarks.getSubTree(root.id);
  return full ? walk(full) : null;
}

async function applyCloudCategory(c, li, keepBtn, applyBtn) {
  const tn = c.tn;
  const cloudPath = Array.isArray(c.cloudPath) ? c.cloudPath : [];
  if (!tn || !tn.url) {
    applyBtn.disabled = true;
    return;
  }
  try {
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0] && tree[0].children ? tree[0].children[0] : null;
    const folder =
      (bar.children || []).find((f) => f.url === undefined && f.title === 'TagNest') ||
      (await chrome.bookmarks.create({ parentId: bar.id, title: 'TagNest' }));
    const node = await findBookmarkByUrl(folder, tn.url);
    if (!node) {
      applyBtn.textContent = '未找到本地书签';
      applyBtn.disabled = true;
      return;
    }
    const targetId = await ensureFolderChain(folder.id, cloudPath);
    await chrome.bookmarks.move(node.id, { parentId: targetId });
    li.style.opacity = '0.5';
    keepBtn.disabled = true;
    applyBtn.disabled = true;
    applyBtn.textContent = '已采用云端分类';
  } catch {
    applyBtn.textContent = '移动失败';
  }
}

els.rollbackBtn.addEventListener('click', async () => {
  els.rollbackBtn.disabled = true;
  const resp = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'rollback-sync' }, resolve));
  if (resp && resp.ok) {
    els.rollbackPanel.hidden = true;
    renderError(`已恢复 ${resp.restored} 个书签（重新同步可从当前浏览器状态重新推导）`);
  } else {
    els.rollbackBtn.disabled = false;
    renderError(resp?.message || '恢复失败');
  }
});

els.openCategoryBuild.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('category.html') }));
els.openReconcile.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('reconcile.html') }));
els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

reflectStatus();

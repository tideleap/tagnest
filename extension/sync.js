// TagNest bidirectional sync page controller (B-12, Phase B).
//
// Talks to the background worker (which owns chrome.bookmarks) via messages.
// Owns no browser-tree reads itself — it only renders state and triggers the
// sync/rollback intents. Conflict resolution "采用 TagNest" is performed here
// locally from the TN item captured in the sync result, so no extra round-trip
// is needed.

import { loadConfig, isConfigured } from './bg/config.js';
import { loadSyncState } from './bg/reconcile.js';

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
  rollbackPanel: $('rollbackPanel'),
  rollbackBtn: $('rollbackBtn'),
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
    els.dirHint.insertAdjacentHTML(
      'beforeend',
      ` 上次同步：${new Date(state.lastSyncedAt).toLocaleString()}`,
    );
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
  els.result.innerHTML = `<h2 class="head">同步未完成</h2><div class="err">${escapeHtml(message)}</div>`;
}

function renderResult(resp) {
  const p = resp.pushed || { applied: 0, failed: 0, errors: [] };
  const a = resp.applied || { created: 0, updated: 0, removed: 0 };
  els.result.hidden = false;
  els.result.className = 'result ok';
  let html = `<h2 class="head">同步完成（${direction === 'two-way' ? '双向' : '仅上传'}）</h2>`;
  html += `<div class="row"><span>浏览器书签</span><b>${resp.browserCount}</b></div>`;
  html += `<div class="row"><span>TagNest 变更</span><b>${resp.tnCount}</b></div>`;
  html += `<div class="row"><span>已上传 / 失败</span><b>${p.applied} / ${p.failed}</b></div>`;
  if (direction === 'two-way') {
    html += `<div class="row"><span>写回浏览器（建/改/删）</span><b>${a.created} / ${a.updated} / ${a.removed}</b></div>`;
  }
  if (p.failed > 0 && Array.isArray(p.errors)) {
    html += `<div class="err">失败明细：${escapeHtml(
      p.errors
        .slice(0, 5)
        .map((e) => `#${e.index} ${e.code}`)
        .join('，'),
    )}</div>`;
  }
  els.result.innerHTML = html;

  const conflicts = Array.isArray(resp.conflictDetails) ? resp.conflictDetails : [];
  if (conflicts.length) {
    els.conflicts.hidden = false;
    els.conflictCount.textContent = String(conflicts.length);
    renderConflicts(conflicts);
  }
  if (direction === 'two-way' && (a.created || a.updated || a.removed)) {
    els.rollbackPanel.hidden = false;
  }
}

function renderConflicts(conflicts) {
  els.conflictList.innerHTML = '';
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

els.openReconcile.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('reconcile.html') }));
els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]),
  );
}

reflectStatus();

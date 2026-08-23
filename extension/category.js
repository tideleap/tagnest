// TagNest category build page controller (CategorySync P2, C3).
//
// Drives the preview → confirm → build → rollback flow. All chrome.bookmarks
// work happens in the background service worker; this page only renders state
// and forwards intents, exactly like sync.js does for two-way sync.

import { loadConfig, isConfigured } from './bg/config.js';
import { clear, el } from './dom.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusText: $('statusText'),
  introPanel: $('introPanel'),
  previewBtn: $('previewBtn'),
  progress: $('progress'),
  progressText: $('progressText'),
  previewPanel: $('previewPanel'),
  previewStats: $('previewStats'),
  previewSamples: $('previewSamples'),
  rebuildNote: $('rebuildNote'),
  confirmBuildBtn: $('confirmBuildBtn'),
  cancelBtn: $('cancelBtn'),
  buildProgressPanel: $('buildProgressPanel'),
  barFill: $('barFill'),
  buildProgressText: $('buildProgressText'),
  result: $('result'),
  rollbackPanel: $('rollbackPanel'),
  rollbackBtn: $('rollbackBtn'),
  openSync: $('openSync'),
  openOptions: $('openOptions'),
};

function baseHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function reflectStatus() {
  const cfg = await loadConfig();
  els.status.hidden = false;
  if (isConfigured(cfg)) {
    els.status.className = 'status';
    els.statusText.textContent = `已连接 ${baseHost(cfg.baseUrl)}`;
  } else {
    els.status.className = 'status warn';
    els.statusText.textContent = '尚未配置服务器与密钥';
  }
}

async function hasBookmarksPermission() {
  try {
    return Boolean(await chrome.permissions.contains({ permissions: ['bookmarks'] }));
  } catch {
    return false;
  }
}

async function ensureBookmarksPermission() {
  if (await hasBookmarksPermission()) return true;
  const granted = await chrome.permissions
    .request({ permissions: ['bookmarks'] })
    .catch(() => false);
  return Boolean(granted);
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function renderError(message) {
  els.result.hidden = false;
  els.result.className = 'result err';
  clear(els.result);
  els.result.append(el('h2', 'head', '未完成'));
  els.result.append(el('div', 'err', message));
}

// ---------------------------------------------------------------------------
// Preview (C3-2)
// ---------------------------------------------------------------------------

els.previewBtn.addEventListener('click', async () => {
  els.result.hidden = true;
  els.previewPanel.hidden = true;
  els.rollbackPanel.hidden = true;
  els.progress.hidden = false;
  els.progressText.textContent = '正在拉取云端分类…';
  els.previewBtn.disabled = true;

  try {
    if (!(await ensureBookmarksPermission())) {
      renderError('需要「书签」权限才能读取浏览器书签树');
      return;
    }
    const resp = await send({ type: 'category-preview' });
    if (!resp) {
      renderError('扩展后台未响应，请重新打开扩展');
      return;
    }
    if (!resp.ok) {
      renderError(resp.notConfigured ? '请先在设置中配置服务器与密钥' : resp.message || '预览失败');
      return;
    }
    renderPreview(resp);
  } catch (err) {
    renderError(err?.message || '预览失败');
  } finally {
    els.progress.hidden = true;
    els.previewBtn.disabled = false;
  }
});

function renderPreview(resp) {
  const s = resp.stats;
  const totalOps =
    s.foldersToCreate + s.bookmarksToCreate + s.bookmarksToMove + s.titlesToUpdate + s.nodesToRemove;

  const target = resp.mode === 'bar' ? '书签栏根目录（提升模式）' : '书签栏「TagNest」文件夹';
  clear(els.previewStats);
  const addRow = (label, value) => {
    const row = el('div', 'row');
    row.append(el('span', null, label));
    row.append(el('b', null, String(value)));
    els.previewStats.append(row);
  };
  addRow('目标位置', target);
  addRow('云端已分类书签', resp.feedTotal);
  addRow('托管文件夹现状（文件夹/书签）', `${resp.current.folders} / ${resp.current.bookmarks}`);
  addRow('将新建文件夹', s.foldersToCreate);
  addRow('将放置书签（新建/移动/改名）', `${s.bookmarksToCreate} / ${s.bookmarksToMove} / ${s.titlesToUpdate}`);
  addRow('将清理过期节点', s.nodesToRemove);
  addRow('已就位无需改动', s.unchanged);

  clear(els.previewSamples);
  const samples = resp.samples || {};
  const addSampleGroup = (title, items) => {
    if (!items.length) return;
    const group = el('div', 'sample-group');
    group.append(el('p', 'sample-title', title));
    const ul = el('ul', 'sample-list');
    for (const li of items) ul.append(li);
    group.append(ul);
    els.previewSamples.append(group);
  };
  addSampleGroup(
    '将新建的文件夹（示例）',
    (samples.createFolders || []).map((p) => el('li', null, p)),
  );
  addSampleGroup(
    '将放置的书签（示例）',
    (samples.createBookmarks || []).map((b) => {
      const li = el('li');
      li.append(document.createTextNode(`${b.title} `));
      li.append(el('span', 'path', `→ ${b.path}`));
      return li;
    }),
  );
  addSampleGroup(
    '将移动的书签（示例）',
    (samples.moveBookmarks || []).map((m) => {
      const li = el('li');
      li.append(document.createTextNode(`${m.title} `));
      li.append(el('span', 'path', `${m.from || '根目录'} → ${m.to}`));
      return li;
    }),
  );

  els.rebuildNote.hidden = !resp.managedFolderMissing;
  els.previewPanel.hidden = false;
  els.confirmBuildBtn.disabled = totalOps === 0;

  // Promote mode: a "missing managed folder" note is meaningless (the bar
  // always exists), and rollback only undoes owned nodes — say so.
  if (resp.mode === 'bar') {
    els.rebuildNote.hidden = true;
    const rh = $('rollbackHint');
    if (rh) {
      rh.textContent =
        '提升模式下本次构建的分类节点直接位于书签栏顶层。若结果不符合预期，可一键撤销——仅移除本次写入的自有分类节点，你原有的其他书签与文件夹不受影响。';
    }
  }

  if (totalOps === 0) {
    els.result.hidden = false;
    els.result.className = 'result ok';
    clear(els.result);
    els.result.append(el('h2', 'head', '书签栏已与云端分类一致，无需构建'));
  }
}

els.cancelBtn.addEventListener('click', () => {
  els.previewPanel.hidden = true;
});

// ---------------------------------------------------------------------------
// Build (C3-1/C3-3/C3-6) with live progress
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'category-build-progress') {
    const pct = msg.total > 0 ? Math.round((msg.done / msg.total) * 100) : 0;
    els.barFill.style.width = `${pct}%`;
    els.buildProgressText.textContent = `${msg.done} / ${msg.total}（${phaseLabel(msg.phase)}）`;
  }
});

function phaseLabel(phase) {
  if (phase === 'folders') return '创建文件夹';
  if (phase === 'moves') return '移动书签';
  if (phase === 'creates') return '放置书签';
  if (phase === 'updates') return '更新标题';
  if (phase === 'removes') return '清理过期节点';
  return '处理中';
}

els.confirmBuildBtn.addEventListener('click', async () => {
  els.previewPanel.hidden = true;
  els.result.hidden = true;
  els.rollbackPanel.hidden = true;
  els.buildProgressPanel.hidden = false;
  els.barFill.style.width = '0%';
  els.buildProgressText.textContent = '准备中…';
  els.confirmBuildBtn.disabled = true;

  try {
    const resp = await send({ type: 'category-build' });
    els.buildProgressPanel.hidden = true;
    if (!resp) {
      renderError('扩展后台未响应，请重新打开扩展');
      return;
    }
    if (!resp.ok) {
      renderError(resp.notConfigured ? '请先在设置中配置服务器与密钥' : resp.message || '构建失败');
      return;
    }
    renderBuildResult(resp);
  } catch (err) {
    els.buildProgressPanel.hidden = true;
    renderError(err?.message || '构建失败');
  } finally {
    els.confirmBuildBtn.disabled = false;
  }
});

function renderBuildResult(resp) {
  const s = resp.stats || {};
  els.result.hidden = false;
  els.result.className = 'result ok';
  clear(els.result);
  els.result.append(el('h2', 'head', '分类书签栏构建完成'));
  const addRow = (label, value) => {
    const row = el('div', 'row');
    row.append(el('span', null, label));
    row.append(el('b', null, String(value)));
    els.result.append(row);
  };
  addRow('执行操作', resp.executed);
  if (resp.failed > 0) addRow('失败（可再次构建补齐）', resp.failed);
  addRow('新建文件夹 / 放置书签', `${s.foldersToCreate} / ${s.bookmarksToCreate + s.bookmarksToMove}`);
  addRow('整树快照', resp.snapshotTaken ? '已保存' : '未保存');
  if (resp.snapshotTaken) {
    els.rollbackPanel.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Rollback (C3-4)
// ---------------------------------------------------------------------------

els.rollbackBtn.addEventListener('click', async () => {
  els.rollbackBtn.disabled = true;
  const resp = await send({ type: 'category-rollback' });
  if (resp && resp.ok) {
    els.rollbackPanel.hidden = true;
    els.result.hidden = false;
    els.result.className = 'result ok';
    clear(els.result);
    els.result.append(el('h2', 'head', `已恢复构建前状态（${resp.restored} 个节点）`));
  } else {
    els.rollbackBtn.disabled = false;
    renderError(resp?.message || '恢复失败');
  }
});

els.openSync.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('sync.html') }));
els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

reflectStatus();

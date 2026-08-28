// TagNest popup interaction logic.
import { loadConfig, isConfigured } from '../bg/config.js';
import { loadExtTheme, applyExtTheme } from '../bg/theme.js';
import { clear, el } from '../dom.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusText: $('statusText'),
  guideCard: $('guideCard'),
  guideGoBtn: $('guideGoBtn'),
  modeBadge: $('modeBadge'),
  syncStatus: $('syncStatus'),
  lastSyncText: $('lastSyncText'),
  pendingUploadText: $('pendingUploadText'),
  coverageText: $('coverageText'),
  savePage: $('savePage'),
  captureWindow: $('captureWindow'),
  noteInput: $('noteInput'),
  result: $('result'),
  openOptions: $('openOptions'),
  openSync: $('openSync'),
  openTwoWaySync: $('openTwoWaySync'),
  openCategoryBuild: $('openCategoryBuild'),
  shortcutHint: $('shortcutHint'),
};

function showResult(kind, title, fine) {
  els.result.className = `result ${kind}`;
  els.result.hidden = false;
  clear(els.result);
  els.result.append(el('div', 'badge', title));
  if (fine) els.result.append(el('div', 'fine', fine));
}

function clearResult() {
  els.result.hidden = true;
  els.result.className = 'result';
  clear(els.result);
}

async function reflectStatus() {
  const cfg = await loadConfig();
  if (isConfigured(cfg)) {
    els.status.hidden = false;
    els.status.className = 'status ok';
    els.statusText.textContent = `已连接 ${baseHost(cfg.baseUrl)}`;
    // P1: configured — hide the setup guide.
    if (els.guideCard) els.guideCard.hidden = true;
  } else {
    els.status.hidden = false;
    els.status.className = 'status warn';
    els.statusText.textContent = '尚未配置服务器与密钥';
    // P1: not configured — proactively surface the three-step pairing guide
    // instead of waiting for a failed save attempt.
    if (els.guideCard) els.guideCard.hidden = false;
  }
  // P6-A: surface the current category placement mode in the popup.
  if (els.modeBadge) {
    if (cfg && cfg.promoteToBar) {
      els.modeBadge.hidden = false;
      els.modeBadge.textContent = '分类位置：整个书签栏（提升模式）';
      els.modeBadge.className = 'mode-badge promote';
    } else {
      els.modeBadge.hidden = false;
      els.modeBadge.textContent = '分类位置：TagNest 子文件夹';
      els.modeBadge.className = 'mode-badge';
    }
  }
}

function baseHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// CS-P4-2 (C5-4): show last sync time, pending upload count and cloud
// category coverage. The background worker computes everything; the popup
// only renders. Missing fields (null) render as a dash.
async function reflectSyncStatus() {
  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'sync-status' }, resolve);
  });
  if (!resp || !resp.ok) return;
  els.syncStatus.hidden = false;

  els.lastSyncText.textContent = resp.lastSyncedAt ? formatSyncTime(resp.lastSyncedAt) : '尚未同步';
  els.pendingUploadText.textContent =
    resp.pendingUpload === null || resp.pendingUpload === undefined ? '—' : `${resp.pendingUpload} 条`;
  els.coverageText.textContent = resp.coverage
    ? `${resp.coverage.percent}%（${resp.coverage.categorized}/${resp.coverage.bookmarks}）`
    : '—';
}

function formatSyncTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setBusy(which, busy) {
  const btn = els[which];
  btn.disabled = busy;
}

els.savePage.addEventListener('click', async () => {
  clearResult();
  setBusy('savePage', true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      showResult('warn', '当前标签页无法收藏', '仅支持 http/https 页面');
      return;
    }
    const note = els.noteInput.value.trim();
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'save-page', url: tab.url, title: tab.title || '', note }, resolve);
    });
    if (!resp) {
      showResult('err', '扩展后台未响应', '请重新打开扩展面板');
      return;
    }
    if (!resp.ok) {
      if (resp.notConfigured) {
        showResult('info', '需要先配置扩展', '点击下方「设置」填写服务器与 API 密钥');
      } else {
        showResult('err', '收藏失败', resp.message || '未知错误');
      }
      return;
    }
    els.noteInput.value = '';
    if (resp.existed) {
      showResult('ok', '已在书签库中', resp.noteAppended ? '新笔记已追加到该书签' : null);
    } else {
      showResult('ok', '已收藏进收件箱', note ? '笔记已一并保存' : '整理打标前会待在收件箱');
    }
  } catch (err) {
    showResult('err', '收藏失败', err?.message || '未知错误');
  } finally {
    setBusy('savePage', false);
  }
});

els.captureWindow.addEventListener('click', async () => {
  clearResult();
  setBusy('captureWindow', true);
  try {
    const win = await chrome.windows.getCurrent();
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'capture-window', windowId: win.id }, resolve);
    });
    if (!resp) {
      showResult('err', '扩展后台未响应', '请重新打开扩展面板');
      return;
    }
    if (resp.notConfigured) {
      showResult('info', '需要先配置扩展', '点击「设置」填写服务器与 API 密钥');
      return;
    }
    if (resp.message) {
      showResult('warn', '未执行收纳', resp.message);
    } else if (resp.saved === 0 && resp.existed === 0) {
      showResult('warn', '没有可收藏的标签页', '当前窗口仅含 http/https 页面才会被收纳');
    } else {
      let fine = `新增 ${resp.saved}，已存在 ${resp.existed}`;
      if (resp.failed > 0) fine += `，失败 ${resp.failed}`;
      if (resp.group) fine += `，已归档到「${resp.group}」`;
      showResult('ok', `收纳完成`, fine);
    }
  } catch (err) {
    showResult('err', '收纳失败', err?.message || '未知错误');
  } finally {
    setBusy('captureWindow', false);
  }
});

function openOptions() {
  chrome.runtime.openOptionsPage();
}
els.openOptions.addEventListener('click', openOptions);
els.openOptions.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openOptions();
  }
});

// P1: the guide card's primary action goes straight to the options wizard.
if (els.guideGoBtn) els.guideGoBtn.addEventListener('click', openOptions);

// Open the read-only reconciliation page (B-12 Phase A) in its own tab.
els.openSync.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('reconcile.html') });
});

// Open the bidirectional sync page (B-12 Phase B) in its own tab.
els.openTwoWaySync.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('sync.html') });
});

// Open the category build page (CategorySync P2) in its own tab.
els.openCategoryBuild.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('category.html') });
});

// Apply the chosen theme (from extension settings; system -> OS). Follow live
// changes so opening the popup after changing settings reflects instantly.
(async () => {
  const mode = await loadExtTheme();
  applyExtTheme(mode);
})();
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.tagnestExtTheme?.newValue) {
    applyExtTheme(changes.tagnestExtTheme.newValue);
  }
});

reflectStatus();
reflectSyncStatus();

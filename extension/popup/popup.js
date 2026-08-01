// TagNest popup interaction logic.
import { loadConfig, isConfigured } from '../bg/config.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusText: $('statusText'),
  savePage: $('savePage'),
  captureWindow: $('captureWindow'),
  result: $('result'),
  openOptions: $('openOptions'),
  shortcutHint: $('shortcutHint'),
};

function showResult(kind, title, fine) {
  els.result.className = `result ${kind}`;
  els.result.hidden = false;
  els.result.innerHTML = `<div class="badge">${title}</div>${fine ? `<div class="fine">${fine}</div>` : ''}`;
}

function clearResult() {
  els.result.hidden = true;
  els.result.className = 'result';
  els.result.innerHTML = '';
}

async function reflectStatus() {
  const cfg = await loadConfig();
  if (isConfigured(cfg)) {
    els.status.hidden = false;
    els.status.className = 'status ok';
    els.statusText.textContent = `已连接 ${baseHost(cfg.baseUrl)}`;
  } else {
    els.status.hidden = false;
    els.status.className = 'status warn';
    els.statusText.textContent = '尚未配置服务器与密钥';
  }
}

function baseHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'save-page', url: tab.url, title: tab.title || '' }, resolve);
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
    const kind = resp.created === false ? '已存在' : '已收藏';
    showResult('ok', `${kind}：${resp.existed ? '已在书签库中' : '已加入书签库'}`);
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

// Reflect theme so the popup matches the app/OS preference.
if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
  document.documentElement.setAttribute('data-theme', 'dark');
}
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => {
  document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
});

reflectStatus();

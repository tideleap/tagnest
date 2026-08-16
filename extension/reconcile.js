// TagNest reconciliation page logic (B-12, Phase A — read-only).
import { loadConfig, isConfigured } from './bg/config.js';
import { reconcile } from './bg/reconcile.js';
import { loadExtTheme, applyExtTheme } from './bg/theme.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusText: $('statusText'),
  permissionGate: $('permissionGate'),
  grantBtn: $('grantBtn'),
  result: $('result'),
  summary: $('summary'),
  lists: $('lists'),
  onlyInBrowser: $('onlyInBrowser'),
  onlyInTagNest: $('onlyInTagNest'),
  both: $('both'),
  refreshBtn: $('refreshBtn'),
  openApp: $('openApp'),
  openOptions: $('openOptions'),
};

function showStatus(kind, text) {
  els.status.hidden = false;
  els.status.className = `status ${kind}`;
  els.statusText.textContent = text;
}
function showResult(kind, title, fine) {
  els.result.hidden = false;
  els.result.className = `result ${kind}`;
  els.result.innerHTML = `<div class="badge">${title}</div>${fine ? `<div class="fine">${fine}</div>` : ''}`;
}
function clearResult() {
  els.result.hidden = true;
  els.result.className = 'result';
  els.result.innerHTML = '';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
function renderItem(item, sub) {
  const title = esc(item.title || item.url || '(无标题)');
  const url = esc(item.url || '');
  return `<li class="item"><div class="item-title">${title}</div>${
    url ? `<div class="item-url">${url}</div>` : ''
  }<div class="item-sub">${sub}</div></li>`;
}
function renderList(container, heading, items, render) {
  container.innerHTML = `<h2>${heading} <span class="count">${items.length}</span></h2>${
    items.length
      ? `<ul class="bmlist">${items.map(render).join('')}</ul>`
      : '<p class="empty">无</p>'
  }`;
}

async function runReconcile() {
  clearResult();
  showStatus('warn', '对账中…');
  els.refreshBtn.disabled = true;
  try {
    const cfg = await loadConfig();
    const res = await reconcile(cfg);

    els.status.hidden = true;
    els.summary.hidden = false;
    els.summary.innerHTML = `
      <div class="stat"><b>${res.browserCount}</b><span>浏览器书签</span></div>
      <div class="stat"><b>${res.tnCount}</b><span>TagNest 书签</span></div>
      <div class="stat pos"><b>${res.counts.both}</b><span>已同步</span></div>
      <div class="stat up"><b>${res.counts.onlyInBrowser}</b><span>仅浏览器（可上行）</span></div>
      <div class="stat down"><b>${res.counts.onlyInTagNest}</b><span>仅 TagNest（可下行）</span></div>`;

    els.lists.hidden = false;
    renderList(
      els.onlyInBrowser,
      '仅浏览器（可上行）',
      res.onlyInBrowser,
      (it) => renderItem(it, `key: ${esc(it.urlKey)}`),
    );
    renderList(
      els.onlyInTagNest,
      '仅 TagNest（可下行）',
      res.onlyInTagNest,
      (it) => renderItem(it, `key: ${esc(it.urlKey)}`),
    );
    renderList(els.both, '已同步', res.both, (it) => renderItem(it.browser, `key: ${esc(it.urlKey)}`));

    els.refreshBtn.hidden = false;
    showResult('ok', '对账完成', '本视图只读，暂不改写浏览器书签。');
  } catch (err) {
    showStatus('warn', '对账失败');
    showResult('err', '对账失败', err?.message || '未知错误');
    els.refreshBtn.hidden = false;
  } finally {
    els.refreshBtn.disabled = false;
  }
}

async function ensurePermissionAndRun() {
  const has = await chrome.permissions.contains({ permissions: ['bookmarks'] });
  if (has) {
    els.permissionGate.hidden = true;
    await runReconcile();
    return;
  }
  els.permissionGate.hidden = false;
}

els.grantBtn.addEventListener('click', async () => {
  els.grantBtn.disabled = true;
  try {
    const granted = await chrome.permissions.request({ permissions: ['bookmarks'] });
    if (granted) {
      els.permissionGate.hidden = true;
      await runReconcile();
    } else {
      showResult('warn', '未授权', '需要书签读取权限才能对账。');
      els.grantBtn.disabled = false;
    }
  } catch (err) {
    showResult('err', '授权失败', err?.message || '未知错误');
    els.grantBtn.disabled = false;
  }
});
els.refreshBtn.addEventListener('click', runReconcile);
els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.openOptions.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  }
});
els.openApp.addEventListener('click', async () => {
  const cfg = await loadConfig();
  chrome.tabs.create({ url: cfg.baseUrl || 'https://tagnest.pages.dev' });
});

(async () => {
  const mode = await loadExtTheme();
  applyExtTheme(mode);

  const cfg = await loadConfig();
  if (!isConfigured(cfg)) {
    showResult('info', '需要先配置扩展', '请点击「设置」填写服务器地址与 API 密钥。');
    els.openOptions.hidden = false;
    return;
  }
  await ensurePermissionAndRun();
})();

// TagNest reconciliation page logic (B-12, Phase A — read-only).
import { loadConfig, isConfigured } from './bg/config.js';
import { reconcile } from './bg/reconcile.js';
import { loadExtTheme, applyExtTheme } from './bg/theme.js';
import { clear, el } from './dom.js';

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
  clear(els.result);
  els.result.append(el('div', 'badge', title));
  if (fine) els.result.append(el('div', 'fine', fine));
}
function clearResult() {
  els.result.hidden = true;
  els.result.className = 'result';
  clear(els.result);
}
function renderItem(item, sub) {
  const li = el('li', 'item');
  li.append(el('div', 'item-title', item.title || item.url || '(无标题)'));
  if (item.url) li.append(el('div', 'item-url', item.url));
  li.append(el('div', 'item-sub', sub));
  return li;
}
function renderList(container, heading, items, render) {
  clear(container);
  const h2 = el('h2');
  h2.append(document.createTextNode(`${heading} `));
  h2.append(el('span', 'count', String(items.length)));
  container.append(h2);
  if (items.length) {
    const ul = el('ul', 'bmlist');
    for (const it of items) ul.append(render(it));
    container.append(ul);
  } else {
    container.append(el('p', 'empty', '无'));
  }
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
    clear(els.summary);
    const stat = (cls, value, label) => {
      const d = el('div', cls ? `stat ${cls}` : 'stat');
      d.append(el('b', null, String(value)));
      d.append(el('span', null, label));
      return d;
    };
    els.summary.append(
      stat('', res.browserCount, '浏览器书签'),
      stat('', res.tnCount, 'TagNest 书签'),
      stat('pos', res.counts.both, '已同步'),
      stat('up', res.counts.onlyInBrowser, '仅浏览器（可上行）'),
      stat('down', res.counts.onlyInTagNest, '仅 TagNest（可下行）'),
    );

    els.lists.hidden = false;
    renderList(
      els.onlyInBrowser,
      '仅浏览器（可上行）',
      res.onlyInBrowser,
      (it) => renderItem(it, `key: ${it.urlKey}`),
    );
    renderList(
      els.onlyInTagNest,
      '仅 TagNest（可下行）',
      res.onlyInTagNest,
      (it) => renderItem(it, `key: ${it.urlKey}`),
    );
    renderList(els.both, '已同步', res.both, (it) => renderItem(it.browser, `key: ${it.urlKey}`));

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

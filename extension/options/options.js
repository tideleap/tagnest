// TagNest options page logic.
import { loadConfig, saveConfig, clearConfig, isConfigured } from '../bg/config.js';
import { apiFetch, ApiError } from '../bg/api.js';
import {
  EXT_THEME_OPTIONS,
  EXT_THEME_KEY,
  loadExtTheme,
  setExtTheme,
  applyExtTheme,
} from '../bg/theme.js';

const $ = (id) => document.getElementById(id);
const baseUrlEl = $('baseUrl');
const apiKeyEl = $('apiKey');
const feedEl = $('feedback');
const themeEl = $('theme');

function show(kind, text) {
  feedEl.hidden = false;
  feedEl.className = `feedback ${kind}`;
  feedEl.textContent = text;
}

async function init() {
  const cfg = await loadConfig();
  baseUrlEl.value = cfg.baseUrl || '';
  apiKeyEl.value = cfg.apiKey || '';
}

$('saveBtn').addEventListener('click', async () => {
  try {
    await saveConfig({ baseUrl: baseUrlEl.value.trim(), apiKey: apiKeyEl.value.trim() });
    show('ok success', '已保存。现在可以返回扩展面板使用一键收纳。');
  } catch (err) {
    show('err', err?.message || '保存失败');
  }
});

$('testBtn').addEventListener('click', async () => {
  const baseUrl = baseUrlEl.value.trim();
  const apiKey = apiKeyEl.value.trim();
  if (!baseUrl || !apiKey) {
    show('err', '请先填写服务器地址与 API 密钥');
    return;
  }
  $('testBtn').disabled = true;
  try {
    // GET /api/bookmarks?limit=1 validates both reachability and key scope.
    await apiFetch('/api/bookmarks?limit=1', { baseUrl, apiKey, method: 'GET' });
    show('ok success', '连接成功：服务器可达，密钥有效。');
  } catch (err) {
    if (err instanceof ApiError) {
      show('err', err.message);
    } else {
      show('err', err?.message || '连接失败');
    }
  } finally {
    $('testBtn').disabled = false;
  }
});

$('clearBtn').addEventListener('click', async () => {
  await clearConfig();
  baseUrlEl.value = '';
  apiKeyEl.value = '';
  show('ok', '已清除本地配置。');
});

// Link to the in-app key management surface. Uses the saved/deployed base URL
// if present, else the default live site.
$('keyHelpLink').addEventListener('click', (e) => {
  e.preventDefault();
  const base = baseUrlEl.value.trim() || 'https://tagnest.pages.dev';
  window.open(`${base.replace(/\/+$/, '')}/settings`, '_blank', 'noopener');
});

// Populate the theme picker and apply the persisted choice.
function initThemePicker() {
  themeEl.innerHTML = '';
  for (const opt of EXT_THEME_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    themeEl.appendChild(o);
  }
  (async () => {
    const mode = await loadExtTheme();
    themeEl.value = mode;
    applyExtTheme(mode);
  })();
}

themeEl?.addEventListener('change', () => {
  setExtTheme(themeEl.value).catch(() => {});
});

initThemePicker();

init();

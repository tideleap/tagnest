// TagNest options page logic.
import { loadConfig, saveConfig, clearConfig, isConfigured } from '../bg/config.js';
import { apiFetch, ApiError } from '../bg/api.js';
import { wizardStep, wizardDone } from '../bg/wizard.js';
import {
  EXT_THEME_OPTIONS,
  EXT_THEME_KEY,
  loadExtTheme,
  setExtTheme,
  applyExtTheme,
} from '../bg/theme.js';
import { clear } from '../dom.js';

const $ = (id) => document.getElementById(id);
const baseUrlEl = $('baseUrl');
const apiKeyEl = $('apiKey');
const feedEl = $('feedback');
const themeEl = $('theme');
const autoSyncEl = $('autoSync');
const promoteToBarEl = $('promoteToBar');

function show(kind, text) {
  feedEl.hidden = false;
  feedEl.className = `feedback ${kind}`;
  feedEl.textContent = text;
}

// ---------------------------------------------------------------------------
// CS-P4-3 (C5-1) — first-run pairing wizard
// ---------------------------------------------------------------------------
//
// `configured` is derived live from the stored config; `tested` and `built`
// are persisted so the wizard survives page reloads and browser restarts. The
// wizard hides itself once all three steps are done.

const WIZARD_KEY = 'tagnestWizard.v0';
const wizardCard = $('wizardCard');
const wizardFeedback = $('wizardFeedback');
const wizardProgress = $('wizardProgress');
const wizardProgressText = $('wizardProgressText');

async function loadWizardState() {
  const stored = await chrome.storage.local.get(WIZARD_KEY);
  const s = stored[WIZARD_KEY] || {};
  return { tested: Boolean(s.tested), built: Boolean(s.built) };
}

async function saveWizardState(patch) {
  const cur = await loadWizardState();
  await chrome.storage.local.set({ [WIZARD_KEY]: { ...cur, ...patch } });
}

function showWizardFeedback(kind, text) {
  wizardFeedback.hidden = false;
  wizardFeedback.className = `feedback ${kind}`;
  wizardFeedback.textContent = text;
}

function setStepClass(id, state) {
  const el = $(id);
  el.classList.remove('active', 'done');
  if (state) el.classList.add(state);
}

async function renderWizard() {
  const cfg = await loadConfig();
  const configured = isConfigured(cfg);
  const ws = await loadWizardState();
  const step = wizardStep({ configured, tested: ws.tested, built: ws.built });
  const done = wizardDone({ configured, tested: ws.tested, built: ws.built });

  wizardCard.hidden = done;
  if (done) return;

  setStepClass('step-1', configured ? 'done' : step === 1 ? 'active' : '');
  setStepClass('step-2', ws.tested ? 'done' : step === 2 ? 'active' : '');
  setStepClass('step-3', ws.built ? 'done' : step === 3 ? 'active' : '');
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

function sendBg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// Live build progress from the background worker (same channel category.js uses).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'category-build-progress') {
    wizardProgress.hidden = false;
    wizardProgressText.textContent =
      msg.total > 0 ? `构建中 ${msg.done} / ${msg.total}…` : '构建中…';
  }
});

$('wizardSaveBtn').addEventListener('click', async () => {
  try {
    await saveConfig({
      baseUrl: baseUrlEl.value.trim(),
      apiKey: apiKeyEl.value.trim(),
      autoSync: autoSyncEl ? autoSyncEl.value !== 'off' : true,
      promoteToBar: promoteToBarEl ? promoteToBarEl.value === 'on' : false,
    });
    showWizardFeedback('ok success', '已保存配置，进入下一步：测试连接。');
    await renderWizard();
  } catch (err) {
    showWizardFeedback('err', err?.message || '保存失败');
  }
});

$('wizardTestBtn').addEventListener('click', async () => {
  const baseUrl = baseUrlEl.value.trim();
  const apiKey = apiKeyEl.value.trim();
  if (!baseUrl || !apiKey) {
    showWizardFeedback('err', '请先在第 1 步填写服务器地址与 API 密钥');
    return;
  }
  $('wizardTestBtn').disabled = true;
  try {
    await apiFetch('/api/bookmarks?limit=1', { baseUrl, apiKey, method: 'GET' });
    await saveWizardState({ tested: true });
    showWizardFeedback('ok success', '连接成功。最后一步：从云端构建分类书签栏。');
    await renderWizard();
  } catch (err) {
    showWizardFeedback('err', err instanceof ApiError ? err.message : err?.message || '连接失败');
  } finally {
    $('wizardTestBtn').disabled = false;
  }
});

$('wizardBuildBtn').addEventListener('click', async () => {
  $('wizardBuildBtn').disabled = true;
  wizardProgress.hidden = true;
  try {
    if (!(await ensureBookmarksPermission())) {
      showWizardFeedback('err', '需要「书签」权限才能构建分类书签栏');
      return;
    }
    const resp = await sendBg({ type: 'category-build' });
    wizardProgress.hidden = true;
    if (!resp) {
      showWizardFeedback('err', '扩展后台未响应，请重新打开扩展');
      return;
    }
    if (!resp.ok) {
      showWizardFeedback(
        'err',
        resp.notConfigured ? '请先完成第 1、2 步配置与测试' : resp.message || '构建失败',
      );
      return;
    }
    await saveWizardState({ built: true });
    showWizardFeedback('ok success', '分类书签栏构建完成，配对成功！');
    await renderWizard();
  } catch (err) {
    wizardProgress.hidden = true;
    showWizardFeedback('err', err?.message || '构建失败');
  } finally {
    $('wizardBuildBtn').disabled = false;
  }
});

async function init() {
  const cfg = await loadConfig();
  baseUrlEl.value = cfg.baseUrl || '';
  apiKeyEl.value = cfg.apiKey || '';
  if (autoSyncEl) autoSyncEl.value = cfg.autoSync === false ? 'off' : 'on';
  if (promoteToBarEl) promoteToBarEl.value = cfg.promoteToBar === true ? 'on' : 'off';
  await renderWizard();
}

$('saveBtn').addEventListener('click', async () => {
  try {
    await saveConfig({
      baseUrl: baseUrlEl.value.trim(),
      apiKey: apiKeyEl.value.trim(),
      autoSync: autoSyncEl ? autoSyncEl.value !== 'off' : true,
      promoteToBar: promoteToBarEl ? promoteToBarEl.value === 'on' : false,
    });
    show('ok success', '已保存。现在可以返回扩展面板使用一键收纳。');
    await renderWizard();
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
    await saveWizardState({ tested: true });
    show('ok success', '连接成功：服务器可达，密钥有效。');
    await renderWizard();
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
  await chrome.storage.local.remove(WIZARD_KEY);
  baseUrlEl.value = '';
  apiKeyEl.value = '';
  show('ok', '已清除本地配置。');
  await renderWizard();
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
  clear(themeEl);
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

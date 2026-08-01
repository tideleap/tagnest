// TagNest extension configuration.
//
// Kept in chrome.storage.local: the API key is a write-scoped credential and
// must not leak into sync storage. `apiKey` is the `tnk_...` personal access
// key; `baseUrl` is e.g. https://tagnest.pages.dev (no trailing slash).
const KEY = 'tagnestConfig.v0';

const DEFAULTS = {
  baseUrl: 'https://tagnest.pages.dev',
  apiKey: '',
};

export async function loadConfig() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...(stored[KEY] ?? {}) };
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = { ...current, ...patch };
  if (next.apiKey && !String(next.apiKey).startsWith('tnk_')) {
    throw new Error('密钥格式不正确：应以 tnk_ 开头');
  }
  if (next.baseUrl && !/^https?:\/\/.+/i.test(String(next.baseUrl))) {
    throw new Error('服务器地址格式不正确，需要以 http(s):// 开头');
  }
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function clearConfig() {
  await chrome.storage.local.remove(KEY);
}

/** Whether settings are ready to make calls. */
export function isConfigured(cfg) {
  return Boolean(cfg?.baseUrl && cfg?.apiKey);
}

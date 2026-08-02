// Extension theme resolution — mirrors the app's multi-theme system.
//
// The app persists its theme per-device; the extension can't read the site's
// localStorage (separate origin, and we keep host permissions minimal), so the
// extension stores its own choice in chrome.storage.local. The palette set and
// values match src/styles/theme.css so popup/options match the app exactly.
//
// Choices:
//   'light' | 'dark' | 'aurora' | 'blossom' | 'starlight' | 'system'

export const EXT_THEME_KEY = 'tagnestExtTheme';

/** The concrete palettes that exist in popup.css / options.css. */
export const KNOWN_THEMES = ['light', 'dark', 'aurora', 'blossom', 'starlight'];

export const EXT_THEME_OPTIONS = [
  { value: 'light', label: '暖白经典 (light)' },
  { value: 'starlight', label: '星空白昼 (starlight)' },
  { value: 'blossom', label: '暖白樱粉 (blossom)' },
  { value: 'dark', label: '深空午夜 (dark)' },
  { value: 'aurora', label: '极夜青蓝 (aurora)' },
  { value: 'system', label: '跟随系统 (system)' },
];

function prefersDark() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true
  );
}

/** Resolve a user choice to a concrete palette key. */
export function resolveExtTheme(mode) {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  if (KNOWN_THEMES.includes(mode)) return mode;
  return prefersDark() ? 'dark' : 'light';
}

/** Apply the current choice to the document root. */
export function applyExtTheme(mode) {
  const resolved = resolveExtTheme(mode);
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved === 'light' || resolved === 'starlight' || resolved === 'blossom' ? 'light' : 'dark';
  return resolved;
}

/** Read the persisted choice (defaults to 'system'). */
export async function loadExtTheme() {
  const { [EXT_THEME_KEY]: mode } = await chrome.storage.local.get(EXT_THEME_KEY);
  return mode || 'system';
}

/** Persist + apply a choice. */
export async function setExtTheme(mode) {
  await chrome.storage.local.set({ [EXT_THEME_KEY]: mode });
  applyExtTheme(mode);
  return mode;
}

// Theme registry — single source of truth for the theme options.
//
// A theme maps to a `[data-theme='<key>']` block in src/styles/theme.css that
// overrides the `--p-*` semantic tokens (canvas / surface / ink / brand / …).
// `system` is not a real palette: it resolves to `light` or `dark` from the OS.
// Persisting works via zustand; every live theme is also written to
// localStorage `tagnest.theme` so the index.html head script can apply it
// before first paint (no flash).

/** A concrete palette key that exists in theme.css. */
export type ResolvedTheme = 'light' | 'dark' | 'aurora' | 'blossom' | 'starlight';

/** What the user can pick — a concrete theme or "follow the OS". */
export type ThemeMode = ResolvedTheme | 'system';

export interface ThemeOption {
  value: ThemeMode;
  label: string;
  /** Short description shown under the label. */
  hint: string;
  /** Palette family for grouping / swatch. */
  family: 'dark' | 'light' | 'system';
  /** Representative colors for the picker swatch, in CSS hex/oklch order. */
  swatch: { canvas: string; surface: string; accent: string; ink: string };
}

export const THEMES: ThemeOption[] = [
  {
    value: 'light',
    label: '暖白经典',
    hint: '柔和暖白，护眼常读',
    family: 'light',
    swatch: { canvas: '#fbf8f2', surface: '#ffffff', accent: '#d98324', ink: '#3d3a35' },
  },
  {
    value: 'starlight',
    label: '星空白昼',
    hint: '亮白清爽 · 暖星黄点缀',
    family: 'light',
    swatch: { canvas: '#f7fafc', surface: '#ffffff', accent: '#e8b34b', ink: '#2b3a4a' },
  },
  {
    value: 'blossom',
    label: '暖白樱粉',
    hint: '温柔水粉 · 樱花粉强调',
    family: 'light',
    swatch: { canvas: '#fdf6f7', surface: '#ffffff', accent: '#e88aa4', ink: '#4a3740' },
  },
  {
    value: 'dark',
    label: '深空午夜',
    hint: '暗色 · 琥珀金辨识',
    family: 'dark',
    swatch: { canvas: '#22262e', surface: '#2c313b', accent: '#d8a34c', ink: '#e6e9ee' },
  },
  {
    value: 'aurora',
    label: '极夜青蓝',
    hint: '深邃极夜 · 青蓝辉光',
    family: 'dark',
    swatch: { canvas: '#101a26', surface: '#182633', accent: '#4fd0c7', ink: '#d6e4f0' },
  },
  {
    value: 'system',
    label: '跟随系统',
    hint: '按操作系统偏好自动切换',
    family: 'system',
    swatch: { canvas: '#444444', surface: '#555555', accent: '#999999', ink: '#eeeeee' },
  },
];

/** Resolve what the OS preference should map to when a user picks `system`. */
export function resolveSystemTheme(prefersDark: boolean): Exclude<ThemeMode, 'system'> {
  return prefersDark ? 'dark' : 'light';
}

/** The concrete palette a choice lands on — `system` is resolved at runtime. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return resolveSystemTheme(prefersDark);
  return mode;
}

export const THEME_LABEL: Record<ThemeMode, string> = Object.fromEntries(
  THEMES.map((t) => [t.value, t.label]),
) as Record<ThemeMode, string>;

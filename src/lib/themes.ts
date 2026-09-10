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
    label: '冷白经典',
    hint: '冷板岩底 · 靛蓝主色',
    family: 'light',
    // swatch hex 取自 theme.css :root 第一声明（权威源，G-05）
    swatch: { canvas: '#F8FAFC', surface: '#FFFFFF', accent: '#4F46E5', ink: '#0F172A' },
  },
  {
    value: 'starlight',
    label: '星空白昼',
    hint: '亮白清爽 · 暖星金点缀',
    family: 'light',
    swatch: { canvas: '#f5f9fc', surface: '#ffffff', accent: '#d09945', ink: '#1d252d' },
  },
  {
    value: 'blossom',
    label: '暖白樱粉',
    hint: '温柔水粉 · 樱花粉强调',
    family: 'light',
    swatch: { canvas: '#fef4f8', surface: '#ffffff', accent: '#d36a96', ink: '#31252a' },
  },
  {
    value: 'dark',
    label: '深空午夜',
    hint: '暗色 · 靛蓝辨识',
    family: 'dark',
    swatch: { canvas: '#0B1120', surface: '#111827', accent: '#818CF8', ink: '#F9FAFB' },
  },
  {
    value: 'aurora',
    label: '极夜青蓝',
    hint: '深邃极夜 · 青蓝辉光',
    family: 'dark',
    swatch: { canvas: '#000f1a', surface: '#011925', accent: '#4eccd3', ink: '#e2edf3' },
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

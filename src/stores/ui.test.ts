import { describe, it, expect, afterEach, vi } from 'vitest';
import { useTheme, applyTheme } from './ui';
import { THEMES, type ThemeMode } from '@/lib/themes';

// These tests run in happy-dom, so `document.documentElement.dataset.theme` is
// real. They pin the multi-theme switching contract that the whole app depends
// on: setMode writes the theme to <html data-theme>, system follows the OS,
// and every named theme is selectable.
afterEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
  useTheme.getState().setMode('light');
});

describe('applyTheme', () => {
  it.each(THEMES.filter((t) => t.value !== 'system').map((t) => t.value))(
    'sets data-theme=%s for the %s theme',
    (value) => {
      applyTheme(value as ThemeMode);
      expect(document.documentElement.dataset.theme).toBe(value);
    },
  );

  it('resolves system to a concrete palette, never leaving data-theme=system', () => {
    applyTheme('system');
    expect(['light', 'dark']).toContain(document.documentElement.dataset.theme);
  });

  it('resolves system to light when the OS prefers light', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('resolves system to dark when the OS prefers dark', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persists the resolved theme to localStorage', () => {
    applyTheme('aurora');
    expect(localStorage.getItem('tagnest.theme')).toBe('aurora');
  });
});

describe('useTheme store', () => {
  it('setMode applies the theme to the document', () => {
    useTheme.getState().setMode('starlight');
    expect(document.documentElement.dataset.theme).toBe('starlight');
    expect(useTheme.getState().mode).toBe('starlight');
  });

  it('exposes all 6 selectable themes (5 named + system)', () => {
    const values = THEMES.map((t) => t.value);
    expect(values).toContain('light');
    expect(values).toContain('dark');
    expect(values).toContain('aurora');
    expect(values).toContain('blossom');
    expect(values).toContain('starlight');
    expect(values).toContain('system');
  });
});

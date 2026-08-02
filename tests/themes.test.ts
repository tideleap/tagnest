// Unit tests for the multi-theme registry: resolution logic and option set.
import { describe, it, expect } from 'vitest';
import { THEMES, resolveSystemTheme, resolveTheme, THEME_LABEL } from '../src/lib/themes';

describe('theme registry', () => {
  it('exposes the 5 seeded + system options covering the requested styles', () => {
    const values = THEMES.map((t) => t.value);
    expect(values).toContain('light');
    expect(values).toContain('dark');
    expect(values).toContain('aurora'); // 极夜青蓝
    expect(values).toContain('starlight'); // 星空白昼 + 暖星黄
    expect(values).toContain('blossom'); // 暖白 + 樱花粉
    expect(values).toContain('system'); // 跟随系统
  });

  it('gives every theme a label, hint, family and swatch', () => {
    for (const t of THEMES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.hint.length).toBeGreaterThan(0);
      expect(['dark', 'light', 'system']).toContain(t.family);
      expect(t.swatch.canvas).toBeTruthy();
      expect(t.swatch.accent).toBeTruthy();
      expect(typeof THEME_LABEL[t.value]).toBe('string');
    }
  });

  it('has distinguishable accent palettes', () => {
    const accent = (v) => THEMES.find((t) => t.value === v)!.swatch.accent;
    // The three brand accents must not all be identical.
    const set = new Set(['light', 'starlight', 'blossom', 'dark', 'aurora'].map(accent));
    expect(set.size).toBeGreaterThanOrEqual(3);
  });
});

describe('resolveSystemTheme / resolveTheme', () => {
  it('maps system to dark when OS is dark, light otherwise', () => {
    expect(resolveSystemTheme(true)).toBe('dark');
    expect(resolveSystemTheme(false)).toBe('light');
  });

  it('passes concrete themes straight through', () => {
    expect(resolveTheme('aurora', true)).toBe('aurora');
    expect(resolveTheme('aurora', false)).toBe('aurora');
    expect(resolveTheme('blossom', false)).toBe('blossom');
    expect(resolveTheme('starlight', true)).toBe('starlight');
  });

  it('resolves system via the OS flag', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

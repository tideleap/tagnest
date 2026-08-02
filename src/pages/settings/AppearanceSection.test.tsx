import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppearanceSection } from './AppearanceSection';
import { useTheme } from '@/stores/ui';

describe('AppearanceSection (theme picker)', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
    localStorage.clear();
    // Zustand keeps `mode` in memory across tests; reset to a known baseline so
    // aria-pressed assertions start from a clean slate.
    useTheme.getState().setMode('light');
  });

  it('renders every theme option as a button', () => {
    render(<AppearanceSection />);
    for (const label of ['暖白经典', '星空白昼', '暖白樱粉', '深空午夜', '极夜青蓝', '跟随系统']) {
      expect(screen.getByRole('button', { name: `主题：${label}` })).toBeInTheDocument();
    }
  });

  it('clicking a named theme applies it to <html data-theme>', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await user.click(screen.getByRole('button', { name: '主题：极夜青蓝' }));
    expect(document.documentElement.dataset.theme).toBe('aurora');
    expect(localStorage.getItem('tagnest.theme')).toBe('aurora');
  });

  it('marks the active theme with aria-pressed', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    const aurora = screen.getByRole('button', { name: '主题：极夜青蓝' });
    expect(aurora).toHaveAttribute('aria-pressed', 'false');
    await user.click(aurora);
    expect(screen.getByRole('button', { name: '主题：极夜青蓝' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('system resolves to a concrete palette on the document', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await user.click(screen.getByRole('button', { name: '主题：跟随系统' }));
    expect(['light', 'dark']).toContain(document.documentElement.dataset.theme);
  });
});

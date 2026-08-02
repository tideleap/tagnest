import { describe, it, expect } from 'vitest';
import { mapShare, PALETTES } from '../functions/_lib/shares';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    slug: 'reading-list',
    title: '阅读清单',
    description: null,
    tag_ids: '[]',
    match_all_tags: 0,
    include_notes: 1,
    theme: 'default',
    palette: 'light',
    is_active: 1,
    view_count: 3,
    created_at: '2026-01-01',
    updated_at: '2026-01-02',
    expires_at: null,
    ...overrides,
  };
}

describe('mapShare (share row → client shape)', () => {
  it('exposes the palette from the row', () => {
    const share = mapShare(row({ palette: 'aurora' }));
    expect(share.palette).toBe('aurora');
  });

  it('falls back to light for an unknown palette', () => {
    const share = mapShare(row({ palette: 'ultra-violet' }));
    expect(share.palette).toBe('light');
  });

  it('falls back to light when the column is absent', () => {
    const share = mapShare({ ...row(), palette: undefined });
    expect(share.palette).toBe('light');
  });

  it('defaults theme to default', () => {
    const share = mapShare({ ...row(), theme: undefined });
    expect(share.theme).toBe('default');
  });
});

describe('PALETTES', () => {
  it('lists the 5 renderable color palettes', () => {
    expect(PALETTES).toEqual(['light', 'dark', 'aurora', 'blossom', 'starlight']);
  });
});

import { Palette } from 'lucide-react';
import { useTheme, THEMES } from '@/stores/ui';
import { cx } from '@/lib/cx';
import { Card } from './Card';

export function AppearanceSection() {
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);

  return (
    <Card title="主题" description="主题保存在本机，退出登录后仍然保留，并跟随本设备的偏好。">
      <p className="mb-3 text-xs text-ink-soft">选择一个视觉主题，应用到界面配色与字体。</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {THEMES.map((t) => {
          const active = mode === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setMode(t.value)}
              aria-pressed={active}
              aria-label={`主题：${t.label}`}
              className={cx(
                'flex flex-col gap-2 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                active
                  ? 'border-brand bg-brand-soft/35 ring-1 ring-brand/50'
                  : 'border-line bg-surface hover:border-line-strong',
              )}
            >
              {/* Mini preview block in that theme's palette */}
              <span
                className="flex h-12 w-full items-end overflow-hidden rounded-md border border-line p-1.5"
                style={{ background: t.swatch.canvas, borderColor: t.family === 'dark' ? '#00000033' : undefined }}
                aria-hidden
              >
                <span
                  className="h-4 flex-1 rounded-sm"
                  style={{ background: t.swatch.surface, border: '1px solid ' + t.swatch.canvas }}
                />
                <span className="ml-1 h-4 w-4 rounded-sm" style={{ background: t.swatch.accent }} />
                <span
                  className="ml-1 h-1.5 w-6 rounded-full opacity-80"
                  style={{ background: t.swatch.ink }}
                />
              </span>
              <span className="flex items-center justify-between gap-1">
                <span className="text-sm font-medium text-ink">{t.label}</span>
                {active && <Palette size={14} className="text-brand-ink" aria-label="当前主题" />}
              </span>
              <span className="text-2xs leading-tight text-ink-faint">{t.hint}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

import { useState } from 'react';
import { Download, X } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';

/**
 * P2: in-app PWA install banner.
 *
 * Chrome/Edge fire `beforeinstallprompt` when the app is installable; the
 * hook captures it and this banner offers the native install dialog. The
 * banner is non-blocking, sits above the top bar, and once dismissed (or once
 * installed) never returns — dismissal is remembered in localStorage.
 */
export function InstallBanner() {
  const { visible, install, dismiss } = useInstallPrompt();
  const [installing, setInstalling] = useState(false);

  if (!visible) return null;

  const onInstall = async () => {
    setInstalling(true);
    try {
      await install();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      role="status"
      className="anim-atelier-enter flex items-center justify-between gap-3 border-b border-line bg-brand-soft px-4 py-2"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-brand-ink">
        <Download size={14} aria-hidden className="shrink-0" />
        <span className="truncate">安装 TagNest 到主屏幕，像应用一样随时打开</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="primary" loading={installing} onClick={onInstall}>
          安装
        </Button>
        <IconButton
          icon={<X size={14} aria-hidden />}
          label="不再提示"
          variant="ghost"
          size="sm"
          onClick={dismiss}
        />
      </div>
    </div>
  );
}

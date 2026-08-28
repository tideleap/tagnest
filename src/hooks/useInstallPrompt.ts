import { useCallback, useEffect, useState } from 'react';

/**
 * Chrome/Edge's installability signal. The browser fires
 * `beforeinstallprompt` once when the PWA criteria are met; we capture it so
 * the app can show its own install banner instead of relying on the mini
 * infobar (which Chrome retired for most surfaces).
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISS_KEY = 'tagnest.installBanner.dismissed';

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

/**
 * P2: surface the native PWA install prompt as an in-app banner.
 *
 * - `visible` becomes true once the browser deems the app installable,
 *   unless the user dismissed the banner before or already runs installed.
 * - `install()` triggers the native prompt and resolves to whether the user
 *   accepted.
 * - `dismiss()` hides the banner and remembers it (localStorage), so it never
 *   nags again.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (wasDismissed() || isStandalone()) return;

    const onPrompt = (e: Event) => {
      // Prevent the browser's own mini-infobar so our banner is the surface.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setDeferred(null);
      setVisible(false);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async (): Promise<boolean> => {
    if (!deferred) return false;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    setVisible(false);
    return choice.outcome === 'accepted';
  }, [deferred]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Storage unavailable (private mode) — hide for this session only.
    }
    setVisible(false);
  }, []);

  return { visible, install, dismiss };
}

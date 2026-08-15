import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

/**
 * Non-blocking offline notice (X1/X2 PWA hardening).
 *
 * The service worker keeps the app shell renderable offline, but API calls
 * still fail — without a hint the user thinks the app is broken. This banner
 * appears the moment the browser drops connectivity and disappears when it
 * returns; it never blocks interaction.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(() => !navigator.onLine);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-sunken px-4 py-1.5 text-xs text-ink-soft"
    >
      <WifiOff size={13} aria-hidden />
      当前离线：可以浏览已加载的内容，保存等操作需恢复网络后进行
    </div>
  );
}

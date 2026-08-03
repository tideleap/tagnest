import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useUserSettings } from '@/hooks/queries';

/**
 * "自动清空" (auto-clear on idle) — two independent modules:
 *
 *   1. Search:  when enabled, clear the `?q` search filter after the configured
 *               delay of inactivity.
 *   2. Tags:    when enabled, exit the tag-filter route (return to the library)
 *               after the configured delay of inactivity.
 *
 * "Inactivity" means no user interaction (keyboard, pointer, wheel, scroll,
 * touch) for the whole of the delay window. Any activity resets the clock, so a
 * user who is browsing/spacing the input never gets their filters yanked away.
 *
 * This is mounted once in AppLayout and follows the app's convention of wiring
 * window-level listeners inside a useEffect with proper teardown. It reads the
 * live settings via `useUserSettings` so toggling in the Settings page takes
 * effect on the next render without a reload.
 *
 * The timer ticks every second rather than churning setTimeout per keystroke;
 * delays are seconds-scale (default 15/30) so a coarse poll is both cheaper and
 * unambiguous. When there is nothing to clear (feature off, delay 0, or no
 * active filter), the ticker no-ops.
 */
export function useAutoClear() {
  const { data: settings } = useUserSettings();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  const lastActivity = useRef<number>(Date.now());
  const clearedSearch = useRef(false);
  const clearedTags = useRef(false);

  // Track real user activity at the window level. Anything that resets the
  // idle clock belongs here: typing, clicking, scrolling, touch, pointer moves.
  useEffect(() => {
    const bump = () => {
      lastActivity.current = Date.now();
      clearedSearch.current = false;
      clearedTags.current = false;
    };
    const events: (keyof WindowEventMap)[] = [
      'keydown',
      'pointerdown',
      'pointermove',
      'wheel',
      'scroll',
      'touchstart',
    ];
    events.forEach((name) => window.addEventListener(name, bump, { passive: true }));
    return () => events.forEach((name) => window.removeEventListener(name, bump));
  }, []);

  // The actual auto-clear ticker.
  useEffect(() => {
    const searchDelay = settings?.searchAutoClearDelay ?? 15;
    const tagsDelay = settings?.tagsAutoClearDelay ?? 30;
    const searchOn = Boolean(settings?.searchAutoClearEnabled) && searchDelay > 0;
    const tagsOn = Boolean(settings?.tagsAutoClearEnabled) && tagsDelay > 0;

    const hasSearch = params.get('q') !== null && params.get('q') !== '';
    // Tag-filter route: /tags/:tagId
    const isTagRoute = location.pathname.startsWith('/tags/');

    const tick = () => {
      const now = Date.now();

      if (searchOn && hasSearch && !clearedSearch.current) {
        if (now - lastActivity.current >= searchDelay * 1000) {
          clearedSearch.current = true;
          const next = new URLSearchParams(params);
          next.delete('q');
          setParams(next, { replace: true });
        }
      }

      if (tagsOn && isTagRoute && !clearedTags.current) {
        if (now - lastActivity.current >= tagsDelay * 1000) {
          clearedTags.current = true;
          navigate('/library/all', { replace: true });
        }
      }
    };

    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [settings, params, location.pathname, navigate, setParams]);
}

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useUserSettings } from '@/hooks/queries';

/**
 * "自动清空" (auto-clear on idle) — two independent modules:
 *
 *   1. Search:  when enabled, clear the `?q` search filter after the configured
 *               delay of inactivity.
 *   2. Tags:    when enabled, clear the multi-tag `?tagIds` filter after the
 *               configured delay of inactivity.
 *
 * Both clear in place — they delete the search param rather than navigating, so
 * the user stays on the library page. "Inactivity" means no user interaction
 * (keyboard, pointer, wheel, scroll, touch) for the whole delay window; any
 * activity resets the clock.
 *
 * Mounted once in AppLayout; reads live settings via `useUserSettings`. The
 * timer ticks each second (delays are seconds-scale) and no-ops when there is
 * nothing to clear.
 */
export function useAutoClear() {
  const { data: settings } = useUserSettings();
  const [params, setParams] = useSearchParams();

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

    const qParam = params.get('q');
    const hasSearch = qParam !== null && qParam !== '';
    const hasTagFilter = Boolean((params.get('tagIds') ?? '').trim());

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

      if (tagsOn && hasTagFilter && !clearedTags.current) {
        if (now - lastActivity.current >= tagsDelay * 1000) {
          clearedTags.current = true;
          // Delete the tag filter in place — no navigation away.
          const next = new URLSearchParams(params);
          next.delete('tagIds');
          setParams(next, { replace: true });
        }
      }
    };

    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [settings, params, setParams]);
}

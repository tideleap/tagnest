import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOverlay, useSelection } from '@/stores/ui';

/** True when the event originates from somewhere the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable ||
    el.getAttribute('role') === 'textbox'
  );
}

/**
 * App-wide shortcuts.
 *
 * Two rules keep this from fighting the browser and the user:
 *   1. Nothing fires while a text field has focus, except the command palette.
 *   2. Nothing overrides a browser default the user relies on (Cmd+L, Cmd+T…).
 */
export function useGlobalHotkeys() {
  const navigate = useNavigate();
  const { setCommandOpen, setQuickAddOpen, closeAll } = useOverlay();
  const clearSelection = useSelection((s) => s.clear);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Command palette works from anywhere, including inside inputs.
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }

      if (e.key === 'Escape') {
        closeAll();
        clearSelection();
        return;
      }

      if (isTypingTarget(e.target) || meta || e.altKey) return;

      switch (e.key) {
        case 'n':
          e.preventDefault();
          setQuickAddOpen(true);
          break;
        case '/':
          e.preventDefault();
          document.getElementById('global-search')?.focus();
          break;
        case '?':
          e.preventDefault();
          navigate('/settings/shortcuts');
          break;
        default:
          break;
      }

      // `g` then a letter — the vim-ish jump pattern, with a 900 ms window.
      if (e.key === 'g') {
        const onSecond = (second: KeyboardEvent) => {
          window.removeEventListener('keydown', onSecond, true);
          clearTimeout(timer);
          if (isTypingTarget(second.target)) return;
          const routes: Record<string, string> = {
            i: '/library/inbox',
            a: '/library/all',
            f: '/library/favorites',
            r: '/library/archive',
            t: '/tags',
            s: '/settings',
          };
          const target = routes[second.key.toLowerCase()];
          if (target) {
            second.preventDefault();
            navigate(target);
          }
        };
        const timer = setTimeout(
          () => window.removeEventListener('keydown', onSecond, true),
          900,
        );
        window.addEventListener('keydown', onSecond, true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, setCommandOpen, setQuickAddOpen, closeAll, clearSelection]);
}

export const SHORTCUTS: { keys: string[]; description: string; group: string }[] = [
  { keys: ['Ctrl', 'K'], description: '打开命令面板', group: '通用' },
  { keys: ['N'], description: '添加书签', group: '通用' },
  { keys: ['/'], description: '聚焦搜索框', group: '通用' },
  { keys: ['Esc'], description: '关闭弹层 / 取消选择', group: '通用' },
  { keys: ['?'], description: '查看快捷键', group: '通用' },
  { keys: ['G', 'I'], description: '前往收件箱', group: '导航' },
  { keys: ['G', 'A'], description: '前往全部书签', group: '导航' },
  { keys: ['G', 'F'], description: '前往收藏', group: '导航' },
  { keys: ['G', 'R'], description: '前往归档', group: '导航' },
  { keys: ['G', 'T'], description: '前往标签', group: '导航' },
  { keys: ['G', 'S'], description: '前往设置', group: '导航' },
];

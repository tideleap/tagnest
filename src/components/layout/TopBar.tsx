import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LogOut, Menu as MenuIcon, Moon, Plus, Search, Settings, Sun, X } from 'lucide-react';
import { Avatar, Button, ConfirmDialog, IconButton, Kbd, Menu } from '@/components/ui';
import { Magnetic } from '@/components/atelier';
import { useAuth } from '@/stores/auth';
import { useOverlay, useTheme, THEMES } from '@/stores/ui';
import { useDebounced } from '@/hooks/useDebounced';

export function TopBar() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const themeMode = useTheme((s) => s.mode);
  const setThemeMode = useTheme((s) => s.setMode);
  const setMobileNavOpen = useOverlay((s) => s.setMobileNavOpen);
  const setQuickAddOpen = useOverlay((s) => s.setQuickAddOpen);

  const urlQuery = params.get('q') ?? '';
  const [draft, setDraft] = useState(urlQuery);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const debounced = useDebounced(draft, 250);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    if (debounced === urlQuery) return;
    const next = new URLSearchParams(params);
    if (debounced) next.set('q', debounced);
    else next.delete('q');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react only to the debounced query
  }, [debounced]);

  const currentFamily = THEMES.find((t) => t.value === themeMode)?.family ?? 'system';
  const resolvedDark =
    currentFamily === 'dark'
      ? true
      : currentFamily === 'light'
        ? false
        : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = resolvedDark;
  const toggleTheme = () => setThemeMode(isDark ? 'light' : 'dark');

  return (
    <header className="glass sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-line/40 px-3 sm:px-4 xl:px-6">
      <IconButton
        label="打开导航"
        icon={<MenuIcon size={19} />}
        onClick={() => setMobileNavOpen(true)}
        className="chrome-btn md:hidden"
      />

      <div className="min-w-0 flex-1 sm:max-w-md">
        <div className="atelier-search">
          <Search size={16} className="shrink-0 text-ink-faint" aria-hidden />
          <input
            ref={inputRef}
            id="global-search"
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && draft) {
                e.preventDefault();
                setDraft('');
              }
            }}
            placeholder="搜索书签 · 多词=AND，tag:，domain:"
            aria-label="搜索书签"
          />
          {draft ? (
            <button
              type="button"
              onClick={() => {
                setDraft('');
                inputRef.current?.focus();
              }}
              aria-label="清除搜索"
              className="shrink-0 rounded-full p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
            >
              <X size={14} />
            </button>
          ) : (
            <span className="hidden shrink-0 pr-1 sm:flex">
              <Kbd>/</Kbd>
            </span>
          )}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Magnetic strength={0.4} className="hidden sm:inline-flex">
          <Button
            variant="primary"
            iconLeft={<Plus size={16} aria-hidden />}
            onClick={() => setQuickAddOpen(true)}
          >
            添加
          </Button>
        </Magnetic>

        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? '切换到浅色' : '切换到深色'}
          className="chrome-btn"
        >
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        <Menu
          align="end"
          width={210}
          trigger={(props) => (
            <button {...props} className="chrome-btn" aria-label="账户菜单">
              <Avatar name={user?.displayName ?? user?.email ?? '?'} src={user?.avatarUrl} />
            </button>
          )}
          items={[
            { id: 'settings', label: '设置', icon: <Settings size={15} />, onSelect: () => navigate('/settings') },
            {
              id: 'theme',
              label: themeMode === 'system' ? '主题：跟随系统' : `主题：${themeMode === 'dark' ? '深色' : '浅色'}`,
              icon: isDark ? <Moon size={15} /> : <Sun size={15} />,
              onSelect: () =>
                setThemeMode(themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system'),
            },
            {
              id: 'logout',
              label: '退出登录',
              icon: <LogOut size={15} />,
              tone: 'danger',
              separatorBefore: true,
              onSelect: () => setConfirmLogout(true),
            },
          ]}
        />
      </div>

      <ConfirmDialog
        open={confirmLogout}
        onClose={() => setConfirmLogout(false)}
        onConfirm={() => {
          setLoggingOut(true);
          void logout()
            .then(() => {
              setConfirmLogout(false);
              navigate('/signin', { replace: true });
            })
            .finally(() => setLoggingOut(false));
        }}
        title="退出登录"
        message="退出后需要重新输入邮箱和密码才能继续使用。未保存的编辑内容会丢失。"
        confirmLabel="退出登录"
        tone="danger"
        loading={loggingOut}
      />
    </header>
  );
}

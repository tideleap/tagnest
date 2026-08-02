import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LogOut, Menu as MenuIcon, Moon, Plus, Search, Settings, Sun, X } from 'lucide-react';
import { Avatar, Button, IconButton, Input, Kbd, Menu } from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { useOverlay, useTheme } from '@/stores/ui';
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
  const debounced = useDebounced(draft, 250);
  const inputRef = useRef<HTMLInputElement>(null);

  // The URL owns the query; keep the field in step when navigation changes it.
  useEffect(() => {
    setDraft(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    if (debounced === urlQuery) return;
    const next = new URLSearchParams(params);
    if (debounced) next.set('q', debounced);
    else next.delete('q');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react only to the debounced query, not to each URL param change
  }, [debounced]);

  const isDark = document.documentElement.dataset.theme === 'dark';

  return (
    <header className="glass sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line/40 px-3 sm:px-4 xl:px-6">
      <IconButton
        label="打开导航"
        icon={<MenuIcon size={19} />}
        onClick={() => setMobileNavOpen(true)}
        className="md:hidden"
      />

      <div className="min-w-0 flex-1 sm:max-w-md">
        <Input
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
          placeholder="搜索书签…"
          aria-label="搜索书签"
          iconLeft={<Search size={15} />}
          slotRight={
            draft ? (
              <IconButton
                label="清除搜索"
                icon={<X size={14} />}
                size="sm"
                onClick={() => {
                  setDraft('');
                  inputRef.current?.focus();
                }}
              />
            ) : (
              <span className="hidden pr-1.5 sm:flex">
                <Kbd>/</Kbd>
              </span>
            )
          }
        />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button
          variant="primary"
          iconLeft={<Plus size={16} />}
          onClick={() => setQuickAddOpen(true)}
          className="hidden sm:inline-flex"
        >
          添加
        </Button>

        <IconButton
          label={isDark ? '切换到浅色' : '切换到深色'}
          icon={isDark ? <Sun size={17} /> : <Moon size={17} />}
          onClick={() => setThemeMode(isDark ? 'light' : 'dark')}
        />

        <Menu
          align="end"
          width={210}
          trigger={(props) => (
            <button
              {...props}
              className="ml-0.5 rounded-full transition-opacity hover:opacity-85"
              aria-label="账户菜单"
            >
              <Avatar name={user?.displayName ?? user?.email ?? '?'} src={user?.avatarUrl} />
            </button>
          )}
          items={[
            {
              id: 'settings',
              label: '设置',
              icon: <Settings size={15} />,
              onSelect: () => navigate('/settings'),
            },
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
              onSelect: () => {
                void logout().then(() => navigate('/signin', { replace: true }));
              },
            },
          ]}
        />
      </div>
    </header>
  );
}

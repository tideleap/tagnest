import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive,
  ArrowRight,
  Download,
  Inbox,
  Layers,
  Lock,
  LockOpen,
  Moon,
  Plus,
  Search,
  Settings,
  Star,
  Sun,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Kbd, Modal } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useOverlay, useTheme } from '@/stores/ui';
import { useVault } from '@/stores/vault';
import { useBookmarks, useTags } from '@/hooks/queries';
import { useDebounced } from '@/hooks/useDebounced';
import { displayHost } from '@/lib/url';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  group: string;
  run: () => void;
}

/** Subsequence match — "gib" finds "go to inbox". */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();

  const direct = h.indexOf(n);
  if (direct === 0) return 1000;
  if (direct > 0) return 800 - direct;

  let score = 0;
  let position = 0;
  for (const char of n) {
    const found = h.indexOf(char, position);
    if (found === -1) return 0;
    score += found === position ? 12 : 4;
    position = found + 1;
  }
  return score;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const setCommandOpen = useOverlay((s) => s.setCommandOpen);
  const setQuickAddOpen = useOverlay((s) => s.setQuickAddOpen);
  const setEditingBookmarkId = useOverlay((s) => s.setEditingBookmarkId);
  const setThemeMode = useTheme((s) => s.setMode);
  const vaultUnlocked = useVault((s) => s.status === 'unlocked');
  const lockVault = useVault((s) => s.lock);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const debounced = useDebounced(query, 200);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const { data: tags } = useTags();
  // Only search once there is something to search for. The query is fully
  // disabled below the threshold — the old `limit: 0` trick still hit the
  // backend because the server clamps limit to >= 1.
  const searching = debounced.length >= 2;
  const { data: results } = useBookmarks(
    { scope: 'all', q: searching ? debounced : undefined, limit: 6 },
    searching,
  );

  const close = () => setCommandOpen(false);

  const actions = useMemo<Command[]>(() => {
    const isDark = document.documentElement.dataset.theme === 'dark';
    return [
      {
        id: 'add',
        label: '添加书签',
        hint: 'N',
        icon: <Plus size={15} />,
        group: '操作',
        run: () => setQuickAddOpen(true),
      },
      {
        id: 'import',
        label: '导入书签',
        icon: <Download size={15} />,
        group: '操作',
        run: () => navigate('/import'),
      },
      {
        id: 'theme',
        label: isDark ? '切换到浅色主题' : '切换到深色主题',
        icon: isDark ? <Sun size={15} /> : <Moon size={15} />,
        group: '操作',
        run: () => setThemeMode(isDark ? 'light' : 'dark'),
      },
      {
        id: 'nav-inbox',
        label: '收件箱',
        hint: 'G I',
        icon: <Inbox size={15} />,
        group: '前往',
        run: () => navigate('/library/inbox'),
      },
      {
        id: 'nav-all',
        label: '全部书签',
        hint: 'G A',
        icon: <Layers size={15} />,
        group: '前往',
        run: () => navigate('/library/all'),
      },
      {
        id: 'nav-fav',
        label: '收藏',
        hint: 'G F',
        icon: <Star size={15} />,
        group: '前往',
        run: () => navigate('/library/favorites'),
      },
      {
        id: 'nav-archive',
        label: '归档',
        hint: 'G R',
        icon: <Archive size={15} />,
        group: '前往',
        run: () => navigate('/library/archive'),
      },
      {
        id: 'nav-trash',
        label: '回收站',
        icon: <Trash2 size={15} />,
        group: '前往',
        run: () => navigate('/library/trash'),
      },
      {
        id: 'nav-tags',
        label: '标签管理',
        hint: 'G T',
        icon: <TagIcon size={15} />,
        group: '前往',
        run: () => navigate('/tags'),
      },
      {
        id: 'nav-private',
        label: '私密保险库',
        icon: <Lock size={15} />,
        group: '前往',
        run: () => navigate('/private'),
      },
      {
        id: 'nav-settings',
        label: '设置',
        hint: 'G S',
        icon: <Settings size={15} />,
        group: '前往',
        run: () => navigate('/settings'),
      },
      // Only offered while the vault is open — a "lock" command for an already
      // locked vault is noise, and the entry itself would hint at its state.
      ...(vaultUnlocked
        ? [
            {
              id: 'vault-lock',
              label: '锁定私密保险库',
              icon: <LockOpen size={15} />,
              group: '操作',
              run: () => lockVault(),
            } satisfies Command,
          ]
        : []),
    ];
  }, [navigate, setQuickAddOpen, setThemeMode, vaultUnlocked, lockVault]);

  const commands = useMemo<Command[]>(() => {
    const scored = actions
      .map((c) => ({ c, score: fuzzyScore(c.label, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);

    const tagCommands: Command[] = (tags ?? [])
      .map((t) => ({ t, score: fuzzyScore(t.name, query) }))
      .filter((x) => query.length > 0 && x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ t }) => ({
        id: `tag-${t.id}`,
        label: `#${t.name}`,
        hint: `${t.count} 项`,
        icon: <TagIcon size={15} />,
        group: '标签',
        run: () => navigate(`/library/all?tagIds=${encodeURIComponent(t.id)}`),
      }));

    const bookmarkCommands: Command[] = (results?.pages[0]?.items ?? []).map((b) => ({
      id: `bm-${b.id}`,
      label: b.title || displayHost(b.url),
      hint: displayHost(b.url),
      icon: <Search size={15} />,
      group: '书签',
      run: () => setEditingBookmarkId(b.id),
    }));

    return [...bookmarkCommands, ...tagCommands, ...scored];
  }, [actions, tags, results, query, navigate, setEditingBookmarkId]);

  useEffect(() => setActiveIndex(0), [query]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const runAt = (index: number) => {
    const command = commands[index];
    if (!command) return;
    close();
    command.run();
  };

  const grouped = useMemo(() => {
    const map = new Map<string, { command: Command; index: number }[]>();
    commands.forEach((command, index) => {
      const bucket = map.get(command.group) ?? [];
      bucket.push({ command, index });
      map.set(command.group, bucket);
    });
    return [...map.entries()];
  }, [commands]);

  return (
    <Modal open onClose={close} size="sm" hideCloseButton initialFocusRef={inputRef}>
      <div
        role="combobox"
        aria-expanded
        aria-haspopup="listbox"
        aria-controls="command-list"
        className="-mx-5 -mt-4 md:-mt-5"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search size={17} className="shrink-0 text-ink-faint" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % Math.max(commands.length, 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + commands.length) % Math.max(commands.length, 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runAt(activeIndex);
              }
            }}
            placeholder="搜索书签、标签，或执行命令…"
            aria-label="命令面板"
            aria-autocomplete="list"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <Kbd>Esc</Kbd>
        </div>

        <ul
          ref={listRef}
          id="command-list"
          role="listbox"
          className="scrollbar-slim max-h-[min(60dvh,26rem)] overflow-y-auto py-1.5"
        >
          {commands.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-ink-faint">没有匹配的结果</li>
          ) : (
            grouped.map(([group, entries]) => (
              <li key={group}>
                <p className="px-4 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
                  {group}
                </p>
                <ul>
                  {entries.map(({ command, index }) => (
                    <li key={command.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        data-index={index}
                        onMouseMove={() => setActiveIndex(index)}
                        onClick={() => runAt(index)}
                        className={cx(
                          'flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors',
                          index === activeIndex ? 'bg-surface-hover text-ink' : 'text-ink-soft',
                        )}
                      >
                        <span className="shrink-0 text-ink-faint" aria-hidden>
                          {command.icon}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{command.label}</span>
                        {command.hint && (
                          <span className="shrink-0 text-2xs text-ink-faint">{command.hint}</span>
                        )}
                        {index === activeIndex && (
                          <ArrowRight size={13} className="shrink-0 text-ink-faint" aria-hidden />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))
          )}
        </ul>
      </div>
    </Modal>
  );
}

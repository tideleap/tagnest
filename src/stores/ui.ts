import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { BookmarkScope, BookmarkSort } from '@shared/types';

export type ViewMode = 'list' | 'grid' | 'compact';
export type ThemeMode = 'light' | 'dark' | 'system';

interface ViewState {
  viewMode: ViewMode;
  sort: BookmarkSort;
  sidebarCollapsed: boolean;
  setViewMode: (mode: ViewMode) => void;
  setSort: (sort: BookmarkSort) => void;
  toggleSidebar: () => void;
}

/** Persisted view preferences. Purged on logout via `tagnest.view`. */
export const useView = create<ViewState>()(
  persist(
    (set) => ({
      viewMode: 'list',
      sort: 'created_desc',
      sidebarCollapsed: false,
      setViewMode: (viewMode) => set({ viewMode }),
      setSort: (sort) => set({ sort }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    { name: 'tagnest.view' },
  ),
);

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

function applyTheme(mode: ThemeMode) {
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode;
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem('tagnest.theme', resolved);
  } catch {
    /* private mode */
  }
}

/**
 * Theme is intentionally NOT account-scoped — it belongs to the device, so it
 * survives logout on purpose.
 */
export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      mode: 'system',
      setMode: (mode) => {
        applyTheme(mode);
        set({ mode });
      },
    }),
    {
      name: 'tagnest.theme-mode',
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.mode);
      },
    },
  ),
);

// Follow the OS while in `system` mode.
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useTheme.getState().mode === 'system') applyTheme('system');
  });
}

interface OverlayState {
  commandOpen: boolean;
  quickAddOpen: boolean;
  mobileNavOpen: boolean;
  editingBookmarkId: string | null;
  setCommandOpen: (open: boolean) => void;
  setQuickAddOpen: (open: boolean) => void;
  setMobileNavOpen: (open: boolean) => void;
  setEditingBookmarkId: (id: string | null) => void;
  closeAll: () => void;
}

/** Single source of truth for overlays, so two can never fight for the screen. */
export const useOverlay = create<OverlayState>((set) => ({
  commandOpen: false,
  quickAddOpen: false,
  mobileNavOpen: false,
  editingBookmarkId: null,
  setCommandOpen: (commandOpen) => set({ commandOpen, quickAddOpen: false }),
  setQuickAddOpen: (quickAddOpen) => set({ quickAddOpen, commandOpen: false }),
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
  setEditingBookmarkId: (editingBookmarkId) => set({ editingBookmarkId }),
  closeAll: () =>
    set({
      commandOpen: false,
      quickAddOpen: false,
      mobileNavOpen: false,
      editingBookmarkId: null,
    }),
}));

interface SelectionState {
  selected: Set<string>;
  toggle: (id: string) => void;
  selectMany: (ids: string[]) => void;
  clear: () => void;
  isSelected: (id: string) => boolean;
}

export const useSelection = create<SelectionState>((set, get) => ({
  selected: new Set(),
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next };
    }),
  selectMany: (ids) => set({ selected: new Set(ids) }),
  clear: () => set({ selected: new Set() }),
  isSelected: (id) => get().selected.has(id),
}));

export const SCOPE_LABELS: Record<BookmarkScope, string> = {
  inbox: '收件箱',
  all: '全部书签',
  favorites: '收藏',
  archive: '归档',
  trash: '回收站',
};

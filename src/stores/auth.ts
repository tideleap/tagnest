import { create } from 'zustand';
import type { User } from '@shared/types';
import { api, setAccessToken, setUnauthorizedHandler } from '@/lib/api';

/**
 * Keys wiped on logout.
 *
 * Anything caching account-scoped data must be listed here. Leaving a stale
 * cache behind is how the next person to sign in on a shared machine sees
 * someone else's bookmarks.
 */
const ACCOUNT_SCOPED_KEYS = ['tagnest.view', 'tagnest.sidebar', 'tagnest.recent-tags'];

interface AuthState {
  user: User | null;
  status: 'idle' | 'loading' | 'authenticated' | 'anonymous';
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: () => Promise<void>;
  patchUser: (patch: Partial<User>) => void;
}

interface AuthResponse {
  user: User;
  accessToken: string;
}

function purgeLocalAccountData() {
  for (const key of ACCOUNT_SCOPED_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* private mode */
    }
  }
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  status: 'idle',

  bootstrap: async () => {
    set({ status: 'loading' });
    try {
      // The refresh cookie is httpOnly; a successful call hands back a fresh
      // in-memory access token.
      const res = await api.post<AuthResponse>('/auth/refresh', undefined, {
        skipAuthRedirect: true,
      });
      setAccessToken(res.accessToken);
      set({ user: res.user, status: 'authenticated' });
    } catch {
      setAccessToken(null);
      set({ user: null, status: 'anonymous' });
    }
  },

  login: async (email, password) => {
    const res = await api.post<AuthResponse>('/auth/login', { email, password });
    setAccessToken(res.accessToken);
    set({ user: res.user, status: 'authenticated' });
  },

  register: async (email, password, displayName) => {
    const res = await api.post<AuthResponse>('/auth/register', { email, password, displayName });
    setAccessToken(res.accessToken);
    set({ user: res.user, status: 'authenticated' });
  },

  logout: async () => {
    try {
      await api.post('/auth/logout', undefined, { skipAuthRedirect: true });
    } catch {
      // A failed logout call must not strand the user in a signed-in shell.
    }
    setAccessToken(null);
    purgeLocalAccountData();
    set({ user: null, status: 'anonymous' });
  },

  patchUser: (patch) =>
    set((s) => (s.user ? { user: { ...s.user, ...patch } } : s)),
}));

/** Any 401 from the API layer drops the session rather than leaving a half-state. */
setUnauthorizedHandler(() => {
  setAccessToken(null);
  purgeLocalAccountData();
  useAuth.setState({ user: null, status: 'anonymous' });
});

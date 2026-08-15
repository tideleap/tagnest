import { create } from 'zustand';
import type { Bookmark } from '@shared/types';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { keys } from '@/hooks/queries/keys';
import {
  deriveKey,
  makeVerifier,
  checkVerifier,
  randomSalt,
  encryptJson,
  decryptJson,
  type EncryptedBlob,
  type VaultBookmarkData,
} from '@/lib/vault-crypto';

/**
 * Zero-knowledge private-bookmark vault — client state.
 *
 * The passphrase and the derived key NEVER leave the browser. We persist only
 * the PBKDF2 salt and the verifier blob (both useless without the passphrase);
 * the derived `CryptoKey` lives in a module-level variable so it is held
 * in-memory only and is never serialised. Every private bookmark's plaintext
 * is encrypted here before it touches the network.
 */

const VAULT_KEY = 'tagnest.vault';

type VaultStatus = 'unknown' | 'unconfigured' | 'locked' | 'unlocked';

interface PersistedVault {
  salt: string | null;
  verifier: string | null; // JSON-stringified EncryptedBlob
}

/** Derived key held outside the (serialisable) store state. */
let vaultKey: CryptoKey | null = null;

function loadPersisted(): PersistedVault {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (raw) return JSON.parse(raw) as PersistedVault;
  } catch {
    /* private mode / corrupt */
  }
  return { salt: null, verifier: null };
}

function savePersisted(p: PersistedVault) {
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

export interface DecryptedPrivateBookmark {
  id: string;
  isFavorite: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  data: VaultBookmarkData;
}

interface VaultState {
  status: VaultStatus;
  salt: string | null;
  verifier: string | null;
  error: string | null;
  bootstrap: () => Promise<void>;
  setup: (passphrase: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<boolean>;
  lock: () => void;
  getKey: () => CryptoKey | null;
  encryptBookmark: (b: Bookmark) => Promise<EncryptedBlob>;
  decryptBlob: (blob: EncryptedBlob) => Promise<VaultBookmarkData>;
  clearError: () => void;
}

export const useVault = create<VaultState>((set, get) => ({
  status: 'unknown',
  salt: null,
  verifier: null,
  error: null,

  bootstrap: async () => {
    // Already resolved (we may have locked/unlocked in this session).
    if (get().status !== 'unknown') return;
    const persisted = loadPersisted();
    if (persisted.salt) {
      set({
        salt: persisted.salt,
        verifier: persisted.verifier,
        status: vaultKey ? 'unlocked' : 'locked',
      });
      return;
    }
    try {
      const res = await api.get<{
        configured: boolean;
        salt: string | null;
        verifier: string | null;
      }>('/private/vault');
      if (res.configured && res.salt) {
        const next = { salt: res.salt, verifier: res.verifier ?? null };
        savePersisted(next);
        set({ salt: res.salt, verifier: res.verifier ?? null, status: vaultKey ? 'unlocked' : 'locked' });
      } else {
        set({ status: 'unconfigured', salt: null, verifier: null });
      }
    } catch {
      set({ status: 'unconfigured' });
    }
  },

  setup: async (passphrase) => {
    const salt = randomSalt();
    const key = await deriveKey(passphrase, salt);
    const verifier = await makeVerifier(key);
    const verifierStr = JSON.stringify(verifier);
    await api.post('/private/vault', { salt, verifier: verifierStr });
    vaultKey = key;
    const persisted = { salt, verifier: verifierStr };
    savePersisted(persisted);
    set({ salt, verifier: verifierStr, status: 'unlocked', error: null });
  },

  unlock: async (passphrase) => {
    set({ error: null });
    const { salt, verifier } = get();
    if (!salt || !verifier) {
      set({ error: '私密保险库尚未设置' });
      return false;
    }
    const key = await deriveKey(passphrase, salt);
    try {
      const ok = await checkVerifier(key, JSON.parse(verifier) as EncryptedBlob);
      if (!ok) {
        set({ error: '密码不正确，请重试' });
        return false;
      }
    } catch {
      set({ error: '密码不正确，请重试' });
      return false;
    }
    vaultKey = key;
    set({ status: 'unlocked', error: null });
    return true;
  },

  lock: () => {
    vaultKey = null;
    // Purge every cache that can hold vault plaintext (decrypted zero-
    // knowledge rows live in component state and die with unmount, but the
    // category-private listing is server plaintext cached by React Query).
    // Without this, locking and revisiting the page would re-render sensitive
    // rows straight from cache before any gate could stop it.
    queryClient.removeQueries({ queryKey: keys.privateTags });
    queryClient.removeQueries({ queryKey: keys.privateTagBookmarkRoot });
    set({ status: 'locked', error: null });
  },

  getKey: () => vaultKey,

  encryptBookmark: async (b) => {
    if (!vaultKey) throw new Error('私密保险库未解锁');
    const data: VaultBookmarkData = {
      url: b.url,
      title: b.title,
      description: b.description,
      note: b.note,
      faviconUrl: b.faviconUrl,
      coverUrl: b.coverUrl,
      tagNames: b.tags.map((t) => t.name),
      isFavorite: b.isFavorite,
      isArchived: b.isArchived,
    };
    return encryptJson(vaultKey, data);
  },

  decryptBlob: async (blob) => {
    if (!vaultKey) throw new Error('私密保险库未解锁');
    return decryptJson<VaultBookmarkData>(vaultKey, blob);
  },

  clearError: () => set({ error: null }),
}));

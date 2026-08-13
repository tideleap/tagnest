import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Bookmark, BookmarkInput, PrivateBookmarksResponse } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from './keys';
import { useVault } from '@/stores/vault';
import { encryptJson, type EncryptedBlob, type VaultBookmarkData } from '@/lib/vault-crypto';

/** Cache keys for the private vault — kept separate from the public bookmark
 *  lists so unlocking/locking never disturbs the visible library. */
export const vaultKeys = {
  status: ['vault-status'] as const,
  list: ['vault-bookmarks'] as const,
};

export interface DecryptedPrivateFields {
  url: string;
  title: string;
  description: string | null;
  note: string | null;
  faviconUrl: string | null;
  coverUrl: string | null;
  tagNames: string[];
}

export function useVaultStatus() {
  return useQuery({
    queryKey: vaultKeys.status,
    queryFn: () =>
      api.get<{ configured: boolean; salt: string | null; verifier: string | null }>(
        '/private/vault',
      ),
    staleTime: 5 * 60_000,
  });
}

export function useSetupVault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { salt: string; verifier: string }) => api.post('/private/vault', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: vaultKeys.status });
    },
    onError: (e: Error) => toast.error('保险库设置失败', e.message),
  });
}

export function usePrivateBookmarks() {
  return useQuery({
    queryKey: vaultKeys.list,
    queryFn: () => api.get<PrivateBookmarksResponse>('/private/bookmarks'),
  });
}

export function useCreatePrivateBookmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { encryptedBlob: string; isFavorite?: boolean; isArchived?: boolean }) =>
      api.post<{ id: string }>('/private/bookmarks', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: vaultKeys.list });
      toast.success('已保存到私密保险库');
    },
    onError: (e: Error) => toast.error('保存失败', e.message),
  });
}

export function useUpdatePrivateBookmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, encryptedBlob }: { id: string; encryptedBlob: string }) =>
      api.patch(`/private/bookmarks/${id}`, { encryptedBlob }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: vaultKeys.list });
    },
    onError: (e: Error) => toast.error('更新失败', e.message),
  });
}

export function useDeletePrivateBookmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/private/bookmarks/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: vaultKeys.list });
      toast.success('已从私密保险库删除');
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

/**
 * Moves a live (visible) bookmark into the vault. The bookmark's fields are
 * encrypted client-side with the unlocked vault key, then the server blanks the
 * row and flips `is_private = 1`, removing it from every ordinary view.
 */
export function useSetBookmarkPrivate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (bookmark: Bookmark) => {
      // Read the key imperatively: subscribing the hook to the whole vault
      // store would re-render every card on lock/unlock for no benefit.
      const blob: EncryptedBlob = await useVault.getState().encryptBookmark(bookmark);
      await api.patch(`/bookmarks/${bookmark.id}`, {
        isPrivate: true,
        encryptedBlob: JSON.stringify(blob),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.stats });
      void qc.invalidateQueries({ queryKey: keys.tags });
      toast.success('已移入私密保险库');
    },
    onError: (e: Error) => toast.error('操作失败', e.message),
  });
}

/**
 * Restores a private bookmark to a normal, visible one. The decrypted fields are
 * sent back to the server, which re-populates the row and re-links its tags.
 */
export function useUnsetBookmarkPrivate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; fields: DecryptedPrivateFields }) =>
      api.patch(`/bookmarks/${input.id}`, { isPrivate: false, ...input.fields }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: vaultKeys.list });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.stats });
      void qc.invalidateQueries({ queryKey: keys.tags });
      toast.success('已移出私密保险库');
    },
    onError: (e: Error) => toast.error('操作失败', e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Category-private bookmarks inside the vault view
 *
 * These are plaintext rows hidden by PRIVATE_BOOKMARK_CLAUSE because they
 * carry a private tag. They are not encrypted; the vault page merely offers
 * a single place to review and manage them alongside zero-knowledge items.
 * ------------------------------------------------------------------ */

/** Loads a single bookmark that is hidden by a private tag. */
export function usePrivateTagBookmark(id: string | null) {
  return useQuery({
    queryKey: ['private-tag-bookmark', id],
    queryFn: () => api.get<Bookmark>(`/private/category-bookmarks/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/** Edits a category-private bookmark from the vault view. */
export function useUpdatePrivateTagBookmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<BookmarkInput> }) =>
      api.patch<Bookmark | { removedFromVault: true; bookmark: Bookmark }>(`/private/category-bookmarks/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.privateTags });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.stats });
      void qc.invalidateQueries({ queryKey: ['private-tag-bookmark'] });
      toast.success('已保存');
    },
    onError: (e: Error) => toast.error('保存失败', e.message),
  });
}

/** Soft-deletes a category-private bookmark from the vault view. */
export function useDeletePrivateTagBookmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/private/category-bookmarks/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.privateTags });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      void qc.invalidateQueries({ queryKey: keys.stats });
      toast.success('已删除');
    },
    onError: (e: Error) => toast.error('删除失败', e.message),
  });
}

/** Encrypts a fresh set of fields for creating/updating a private bookmark. */
export async function encryptVaultFields(
  data: VaultBookmarkData,
): Promise<EncryptedBlob> {
  const key = useVault.getState().getKey();
  if (!key) throw new Error('私密保险库未解锁');
  return encryptJson(key, data);
}

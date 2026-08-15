import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { PrivateVaultPage } from './PrivateVaultPage';
import { useVault } from '@/stores/vault';
import { queryClient } from '@/lib/queryClient';
import { keys } from '@/hooks/queries/keys';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const getSpy = vi.mocked(api.get);

const SECRET_TITLE = '机密项目计划书';

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <PrivateVaultPage />
    </QueryClientProvider>,
  );
}

describe('PrivateVaultPage access gate', () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
    useVault.setState({ status: 'unknown', salt: null, verifier: null, error: null });
    getSpy.mockReset();
    getSpy.mockImplementation(async (path: string) => {
      if (path === '/private/vault') {
        return { configured: true, salt: 'salt', verifier: 'verifier' };
      }
      if (path === '/private/bookmarks') return { items: [] };
      if (path.startsWith('/private/tags')) {
        return {
          tags: [
            {
              tag: { id: 't1', name: '娱乐休闲', colorIndex: 2 },
              bookmarks: [
                {
                  id: 'b1',
                  url: 'https://secret.example/x',
                  title: SECRET_TITLE,
                  faviconUrl: null,
                  isFavorite: false,
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
  });

  it('locked vault neither fetches nor renders category-private plaintext', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('解锁私密保险库')).toBeInTheDocument());
    // Give a buggy eager fetch every chance to fire before we assert absence.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.queryByText('类别私密')).not.toBeInTheDocument();
    expect(screen.queryByText(SECRET_TITLE)).not.toBeInTheDocument();
    const paths = getSpy.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.startsWith('/private/tags'))).toBe(false);
  });

  it('unlocked vault shows the category-private section', async () => {
    useVault.setState({ status: 'unlocked' });
    renderPage();
    await waitFor(() => expect(screen.getByText(SECRET_TITLE)).toBeInTheDocument());
    expect(screen.getByText('类别私密')).toBeInTheDocument();
  });

  it('locking purges cached plaintext and hides the section again', async () => {
    useVault.setState({ status: 'unlocked' });
    renderPage();
    await waitFor(() => expect(screen.getByText(SECRET_TITLE)).toBeInTheDocument());

    act(() => {
      useVault.getState().lock();
    });

    await waitFor(() => expect(screen.getByText('解锁私密保险库')).toBeInTheDocument());
    expect(screen.queryByText(SECRET_TITLE)).not.toBeInTheDocument();
    expect(queryClient.getQueryData([...keys.privateTags, ''])).toBeUndefined();
  });
});

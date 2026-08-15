import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ShareTargetPage } from './ShareTargetPage';
import { queryClient } from '@/lib/queryClient';
import { api, HttpError } from '@/lib/api';

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

const postSpy = vi.mocked(api.post);

function renderAt(entry: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/share-target" element={<ShareTargetPage />} />
          {/* Landing targets — reaching them proves the post-save navigation. */}
          <Route path="/library/inbox" element={<div>INBOX_LANDED</div>} />
          <Route path="/library/all" element={<div>ALL_LANDED</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ShareTargetPage (Web Share Target receiver)', () => {
  beforeEach(() => {
    queryClient.clear();
    postSpy.mockReset();
  });

  it('prefills from share params and saves into the inbox', async () => {
    const user = userEvent.setup();
    postSpy.mockResolvedValueOnce({ id: 'b1', title: '示例页面' });

    renderAt(
      '/share-target?url=https%3A%2F%2Fexample.com%2Fa&title=%E7%A4%BA%E4%BE%8B%E9%A1%B5%E9%9D%A2&text=%E5%A5%BD%E6%96%87%E7%AB%A0',
    );

    expect(screen.getByDisplayValue('https://example.com/a')).toBeInTheDocument();
    expect(screen.getByDisplayValue('示例页面')).toBeInTheDocument();
    expect(screen.getByDisplayValue('好文章')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存到收件箱' }));

    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith('/bookmarks', {
        url: 'https://example.com/a',
        title: '示例页面',
        note: '好文章',
      }),
    );
    await waitFor(() => expect(screen.getByText('INBOX_LANDED')).toBeInTheDocument());
  });

  it('extracts the link from text-only shares and keeps the rest as note', async () => {
    const user = userEvent.setup();
    postSpy.mockResolvedValueOnce({ id: 'b2' });

    renderAt('/share-target?text=%E7%9C%8B%E7%9C%8B%20https%3A%2F%2Fblog.example.org%2Fp%20%E4%B8%8D%E9%94%99');

    expect(screen.getByDisplayValue('https://blog.example.org/p')).toBeInTheDocument();
    // No explicit title → the leftover text fills BOTH the title and the note.
    expect(screen.getAllByDisplayValue('看看 不错')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: '保存到收件箱' }));
    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith('/bookmarks', {
        url: 'https://blog.example.org/p',
        title: '看看 不错',
        note: '看看 不错',
      }),
    );
  });

  it('shows manual entry when no link can be recovered', () => {
    renderAt('/share-target?text=%E7%BA%AF%E6%96%87%E5%AD%97');
    expect(
      screen.getByText('分享内容里没找到链接，手动填一下网址'),
    ).toBeInTheDocument();
    // The raw text survives in the note field for the user to keep.
    expect(screen.getByDisplayValue('纯文字')).toBeInTheDocument();
  });

  it('rejects an invalid url instead of submitting', async () => {
    const user = userEvent.setup();
    renderAt('/share-target');

    // Simulate the user typing a value that cannot become a link.
    // (The label renders a required-mark asterisk, hence the regex matcher.)
    await user.type(screen.getByLabelText(/网址/), 'not-a-link');
    await user.click(screen.getByRole('button', { name: '保存到收件箱' }));

    expect(screen.getByText('请输入合法的网址')).toBeInTheDocument();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('treats a duplicate (409) as success and goes to the library', async () => {
    const user = userEvent.setup();
    postSpy.mockRejectedValueOnce(new HttpError(409, 'conflict', '该网址已在书签库中'));

    renderAt('/share-target?url=https%3A%2F%2Fexample.com%2Fdup');
    await user.click(screen.getByRole('button', { name: '保存到收件箱' }));

    await waitFor(() => expect(screen.getByText('ALL_LANDED')).toBeInTheDocument());
  });

  it('surfaces other save errors inline', async () => {
    const user = userEvent.setup();
    postSpy.mockRejectedValueOnce(new HttpError(500, 'server_error', '服务器开小差了'));

    renderAt('/share-target?url=https%3A%2F%2Fexample.com%2Ferr');
    await user.click(screen.getByRole('button', { name: '保存到收件箱' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('服务器开小差了'));
  });
});

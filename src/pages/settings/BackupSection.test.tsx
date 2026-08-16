import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BackupSection } from './BackupSection';

vi.mock('@/hooks/queries/backup', () => ({
  useBackupTargets: () => ({
    data: [
      {
        id: 't1',
        kind: 'webdav',
        endpoint: 'https://dav.example.com/',
        bucket: null,
        username: 'me',
        remotePath: '/',
        enabled: true,
        frequency: 'daily',
        lastRunAt: null,
        lastStatus: null,
        createdAt: '',
        updatedAt: '',
      },
    ],
    isLoading: false,
  }),
  useBackupRuns: () => ({ data: [], isLoading: false }),
  useUpsertBackupTarget: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBackupTarget: () => ({ mutate: vi.fn(), isPending: false }),
  useRunBackup: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe('BackupSection', () => {
  it('renders configured targets and the empty-history placeholder', () => {
    render(<BackupSection />);
    expect(screen.getByText('https://dav.example.com/')).toBeInTheDocument();
    expect(screen.getByText('还没有备份记录。')).toBeInTheDocument();
  });

  it('exposes the add-target form fields', () => {
    render(<BackupSection />);
    expect(screen.getByLabelText(/远程地址/)).toBeInTheDocument();
    expect(screen.getByLabelText(/类型/)).toBeInTheDocument();
    expect(screen.getByLabelText(/频率/)).toBeInTheDocument();
  });

  it('shows the save button', () => {
    render(<BackupSection />);
    expect(screen.getByRole('button', { name: /添加目标/ })).toBeInTheDocument();
  });
});

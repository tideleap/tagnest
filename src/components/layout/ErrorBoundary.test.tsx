import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * The boundary wraps the whole router, so a caught error must not stick across
 * navigation. Regression: /organize crashed, the user pressed "back", the URL
 * changed but the crash screen stayed because the boundary never reset.
 */

function Bomb({ message }: { message: string }): ReactElement {
  throw new Error(message);
}

/**
 * Sits OUTSIDE the boundary (but inside the router) — mimics the browser back
 * button, which keeps working even while the crash screen is up.
 */
function BackProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/safe')}>
      返回安全页
    </button>
  );
}

function PathProbe() {
  const { pathname } = useLocation();
  return <span data-testid="pathname">{pathname}</span>;
}

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <PathProbe />
      <BackProbe />
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<div>首页</div>} />
          <Route path="/organize" element={<Bomb message="boom on /organize" />} />
          <Route path="/safe" element={<div>安全页面</div>} />
        </Routes>
      </ErrorBoundary>
    </MemoryRouter>,
  );
}

describe('ErrorBoundary (route-aware reset)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders children when nothing throws', () => {
    renderApp('/');
    expect(screen.getByText('首页')).toBeInTheDocument();
  });

  it('shows the crash screen when a route throws', () => {
    renderApp('/organize');
    expect(screen.getByText('页面出错了')).toBeInTheDocument();
    expect(screen.getByText('boom on /organize')).toBeInTheDocument();
  });

  it('recovers automatically when navigating away from the crashed route', async () => {
    const user = userEvent.setup();
    renderApp('/organize');
    expect(screen.getByText('页面出错了')).toBeInTheDocument();

    // Simulate the browser back button: pathname changes while the error is
    // held. The boundary must clear it and render the new route cleanly.
    await user.click(screen.getByText('返回安全页'));

    expect(screen.getByText('安全页面')).toBeInTheDocument();
    expect(screen.queryByText('页面出错了')).not.toBeInTheDocument();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/safe');
  });
});

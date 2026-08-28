import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/components/ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Route at the time the error was caught — used to detect navigation. */
  errorPathname: string | null;
}

/**
 * Last line of defence.
 *
 * Without this, one render-time exception blanks the entire page and the user
 * has no path back — the single worst failure mode a SPA can ship with.
 *
 * The boundary wraps the whole router, so a caught error would otherwise stick
 * across navigation: the user clicks "back", the URL changes, but the crash
 * screen stays because the boundary never remounts. Resetting on route change
 * gives navigation its natural "fresh attempt" semantics — the same page that
 * crashed is still reachable via explicit retry (重试), while moving anywhere
 * else just works.
 */
class BoundaryInner extends Component<Props & { pathname: string }, State> {
  state: State = { error: null, errorPathname: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: Props & { pathname: string },
    state: State,
  ): Partial<State> | null {
    // First error capture: stamp the route it happened on.
    if (state.error && state.errorPathname === null) {
      return { errorPathname: props.pathname };
    }
    // Navigated away from the route that crashed → clear the error and retry
    // the new route with a clean slate.
    if (state.error && state.errorPathname !== null && props.pathname !== state.errorPathname) {
      return { error: null, errorPathname: null };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[TagNest] render error', error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null, errorPathname: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-critical-soft text-critical">
          <TriangleAlert size={22} />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink">页面出错了</h1>
          <p className="mt-1 max-w-md text-sm text-ink-soft">
            这不是你的操作导致的。可以先重试，若反复出现请刷新页面。切换到其他页面也会自动恢复。
          </p>
        </div>
        <pre className="max-w-lg overflow-x-auto rounded-md bg-sunken px-3 py-2 text-left text-2xs text-ink-faint">
          {error.message}
        </pre>
        <div className="flex gap-2">
          <Button variant="primary" iconLeft={<RotateCcw size={15} />} onClick={this.reset}>
            重试
          </Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
        </div>
      </div>
    );
  }
}

export function ErrorBoundary({ children }: Props) {
  const { pathname } = useLocation();
  return <BoundaryInner pathname={pathname}>{children}</BoundaryInner>;
}

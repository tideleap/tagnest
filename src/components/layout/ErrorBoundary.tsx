import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence.
 *
 * Without this, one render-time exception blanks the entire page and the user
 * has no path back — the single worst failure mode a SPA can ship with.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[TagNest] render error', error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
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
            这不是你的操作导致的。可以先重试，若反复出现请刷新页面。
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

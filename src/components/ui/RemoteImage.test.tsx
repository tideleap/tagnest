import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RemoteImage } from './RemoteImage';

describe('RemoteImage', () => {
  it('renders an <img> with deferred loading', () => {
    render(<RemoteImage src="https://x.test/a.png" data-testid="img" />);
    const img = screen.getByTestId('img');
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', 'https://x.test/a.png');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).toHaveAttribute('alt', '');
  });

  it('respects alt and extra attributes', () => {
    render(
      <RemoteImage src="https://x.test/b.png" alt="封面" className="w-full" data-testid="img" />,
    );
    expect(screen.getByTestId('img')).toHaveAttribute('alt', '封面');
    expect(screen.getByTestId('img').className).toContain('w-full');
  });

  it('renders the fallback instead of the img once the source errors', () => {
    render(<RemoteImage src="broken.png" fallback={<span>加载失败</span>} data-testid="img" />);
    // happy-dom won't auto-fire onError for a broken src, so trigger it via
    // React's synthetic event system.
    fireEvent.error(screen.getByTestId('img'));
    expect(screen.getByText('加载失败')).toBeInTheDocument();
    expect(screen.queryByTestId('img')).toBeNull();
  });
});

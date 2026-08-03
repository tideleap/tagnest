import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('Button', () => {
  it('renders its children', () => {
    render(<Button>保存</Button>);
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
  });

  it('applies the primary variant class', () => {
    render(<Button variant="primary">主要</Button>);
    const btn = screen.getByRole('button', { name: '主要' });
    // Primary now uses the modern gradient treatment (brand-grad) rather than
    // the old flat bg-brand token; assert on the gradient marker.
    expect(btn.className).toContain('brand-grad');
  });

  it('disables interaction while loading and shows a spinner', () => {
    render(
      <Button loading onClick={() => {}}>
        提交中
      </Button>,
    );
    const btn = screen.getByRole('button', { name: '提交中' });
    expect(btn).toBeDisabled();
    // aria-busy marks the in-flight state for assistive tech.
    expect(btn).toHaveAttribute('aria-busy', 'true');
    // The spinner has aria-hidden so it is not announced twice.
    expect(btn.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('defaults to type="button" and does not submit a form', () => {
    render(<Button>默认</Button>);
    expect(screen.getByRole('button', { name: '默认' })).toHaveAttribute('type', 'button');
  });

  it('fires onClick only when not disabled/loading', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>可点</Button>);
    await user.click(screen.getByRole('button', { name: '可点' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    // Re-render disabled; a click must not fire.
    rerender(
      <Button onClick={onClick} disabled>
        禁用
      </Button>,
    );
    await user.click(screen.getByRole('button', { name: '禁用' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forward a ref to the button element', () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(
      <Button ref={ref}>
        引用
      </Button>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.textContent).toBe('引用');
  });
});

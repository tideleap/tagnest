import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';

export type IconButtonVariant = 'ghost' | 'solid' | 'outline' | 'danger';
export type IconButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<IconButtonVariant, string> = {
  ghost: 'text-ink-soft hover:bg-surface-hover hover:text-ink active:bg-sunken',
  solid: 'brand-grad text-on-brand shadow-glow hover:brightness-[0.97]',
  outline: 'border border-line bg-surface text-ink-soft hover:bg-surface-hover hover:text-ink',
  danger: 'text-critical hover:bg-critical-soft active:bg-critical-soft',
};

const SIZE: Record<IconButtonSize, string> = {
  sm: 'h-7 w-7 rounded-md',
  md: 'h-9 w-9 rounded-lg',
  lg: 'h-11 w-11 rounded-lg',
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon alone conveys nothing to a screen reader. */
  label: string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Marks a toggle button's pressed state for assistive technology. */
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', pressed, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cx(
        'inline-flex shrink-0 items-center justify-center transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-50',
        SIZE[size],
        VARIANT[variant],
        pressed && variant === 'ghost' && 'bg-sunken text-ink',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});

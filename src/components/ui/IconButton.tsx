import { cloneElement, forwardRef, isValidElement } from 'react';
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { cx } from '@/lib/cx';

export type IconButtonVariant = 'ghost' | 'solid' | 'outline' | 'danger';
export type IconButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<IconButtonVariant, string> = {
  ghost: 'text-ink-soft hover:bg-surface-hover hover:text-ink active:bg-sunken',
  solid: 'brand-grad text-on-brand shadow-glow hover:brightness-[0.97] active:brightness-[0.93]',
  outline: 'border border-line bg-surface text-ink-soft hover:bg-surface-hover hover:text-ink active:bg-sunken',
  danger: 'text-critical hover:bg-critical-soft hover:text-critical-ink active:bg-critical-soft active:brightness-[0.97]',
};

const SIZE: Record<IconButtonSize, string> = {
  sm: 'h-8 w-8 rounded-md',
  md: 'h-9 w-9 rounded-lg',
  lg: 'h-11 w-11 rounded-lg',
};

/** Default icon pixel size per step; `iconSize` may override on a per-call basis. */
const ICON_SIZE: Record<IconButtonSize, number> = { sm: 14, md: 16, lg: 18 };

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon alone conveys nothing to a screen reader. */
  label: string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Override the rendered icon's pixel size; defaults to ICON_SIZE[size]. */
  iconSize?: number;
  /** Marks a toggle button's pressed state for assistive technology. */
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', iconSize, pressed, className, type = 'button', ...rest },
  ref,
) {
  // Normalise the icon to the size step's default (ICON_SIZE) unless an
  // explicit override is supplied via `iconSize`.
  const sizedIcon = isValidElement(icon)
    ? cloneElement(icon as ReactElement<{ size?: number }>, { size: iconSize ?? ICON_SIZE[size] })
    : icon;

  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cx(
        'inline-flex shrink-0 items-center justify-center transition-colors duration-150 ease-out-soft',
        'focus-ring',
        'disabled:pointer-events-none disabled:opacity-60',
        SIZE[size],
        VARIANT[variant],
        pressed && variant === 'ghost' && 'bg-sunken text-ink',
        className,
      )}
      {...rest}
    >
      {sizedIcon}
    </button>
  );
});

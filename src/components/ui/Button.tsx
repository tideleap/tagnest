import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cx } from '@/lib/cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * Variant styles live in a lookup table rather than inline conditionals so the
 * full set of legal appearances is visible in one place. Adding a sixth
 * variant should feel deliberate.
 */
const VARIANT: Record<ButtonVariant, string> = {
  // `btn-ripple` adds the homepage-style click feedback (CSS ::after pulse) on
  // the two "weight-bearing" variants, so destructive/primary actions respond
  // tactilely while ghost/secondary stay quiet.
  primary:
    'btn-ripple brand-grad text-on-brand shadow-glow hover:-translate-y-px hover:shadow-overlay active:translate-y-0 active:brightness-[0.97] disabled:opacity-60',
  secondary:
    'bg-surface text-ink border border-line hover:bg-surface-hover hover:border-line-strong active:bg-sunken shadow-raised hover:shadow-float',
  ghost: 'bg-transparent text-ink-soft hover:bg-surface-hover hover:text-ink active:bg-sunken',
  danger:
    'btn-ripple bg-critical text-white hover:bg-critical-hover active:bg-critical-hover shadow-raised',
  link: 'bg-transparent text-brand-ink underline-offset-4 hover:underline p-0 h-auto',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-base gap-2 rounded-lg',
};

const ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 15, lg: 17 };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner, disables interaction, keeps the width stable. */
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    iconLeft,
    iconRight,
    fullWidth,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium',
        'transition-all duration-150 ease-out',
        'disabled:pointer-events-none disabled:opacity-60',
        variant !== 'link' && SIZE[size],
        VARIANT[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 size={ICON_SIZE[size]} className="anim-spin" aria-hidden />
      ) : (
        iconLeft
      )}
      {children}
      {!loading && iconRight}
    </button>
  );
});

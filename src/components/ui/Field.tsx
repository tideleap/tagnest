import { forwardRef, useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { cx } from '@/lib/cx';

/* ------------------------------------------------------------------ *
 * Shared shell
 * ------------------------------------------------------------------ */

interface FieldShellProps {
  id: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Wraps a control with its label, hint and error text, and — importantly —
 * wires up the aria-describedby chain so the error is actually announced.
 */
function FieldShell({ id, label, hint, error, required, children, className }: FieldShellProps) {
  return (
    <div className={cx('flex w-full flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="text-xs font-medium text-ink-soft">
          {label}
          {required && (
            <span className="ml-0.5 text-critical" aria-hidden>
              *
            </span>
          )}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-critical-ink">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-ink-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

const CONTROL_BASE =
  'w-full bg-surface text-ink placeholder:text-ink-muted border border-line rounded-md ' +
  'transition-colors duration-150 ease-out-soft ' +
  'hover:border-line-strong ' +
  'focus:border-brand focus-ring-inset ' +
  'disabled:bg-sunken disabled:text-ink-muted disabled:cursor-not-allowed disabled:opacity-60';

const CONTROL_INVALID = 'border-critical focus:border-critical';

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  iconLeft?: ReactNode;
  /** Rendered inside the field on the right — a clear button, a unit, a hotkey hint. */
  slotRight?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  containerClassName?: string;
}

const INPUT_SIZE = {
  sm: 'h-8 text-xs',
  md: 'h-9 text-sm',
  lg: 'h-11 text-base',
} as const;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    iconLeft,
    slotRight,
    size = 'md',
    className,
    containerClassName,
    id,
    required,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;

  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={containerClassName}
    >
      <div className="relative flex items-center">
        {iconLeft && (
          <span className="pointer-events-none absolute left-2.5 flex text-ink-faint" aria-hidden>
            {iconLeft}
          </span>
        )}
        <input
          ref={ref}
          id={fieldId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
          className={cx(
            CONTROL_BASE,
            INPUT_SIZE[size],
            iconLeft ? 'pl-8.5' : 'pl-3',
            slotRight ? 'pr-9' : 'pr-3',
            error && CONTROL_INVALID,
            className,
          )}
          {...rest}
        />
        {slotRight && <span className="absolute right-1.5 flex items-center">{slotRight}</span>}
      </div>
    </FieldShell>
  );
});

/* ------------------------------------------------------------------ *
 * Textarea
 * ------------------------------------------------------------------ */

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  containerClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, containerClassName, id, required, rows = 3, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;

  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={containerClassName}
    >
      <textarea
        ref={ref}
        id={fieldId}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        className={cx(
          CONTROL_BASE,
          'resize-y px-3 py-2 text-sm leading-relaxed',
          error && CONTROL_INVALID,
          className,
        )}
        {...rest}
      />
    </FieldShell>
  );
});

/* ------------------------------------------------------------------ *
 * Select
 * ------------------------------------------------------------------ */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  options: SelectOption[];
  size?: 'sm' | 'md';
  containerClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, size = 'md', className, containerClassName, id, required, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;

  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={containerClassName}
    >
      <div className="relative flex items-center">
        <select
          ref={ref}
          id={fieldId}
          required={required}
          aria-invalid={error ? true : undefined}
          className={cx(
            CONTROL_BASE,
            'cursor-pointer appearance-none bg-no-repeat pl-3 pr-8',
            size === 'sm' ? 'h-8 text-xs' : 'h-9 text-sm',
            error && CONTROL_INVALID,
            className,
          )}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {/* Real DOM chevron so the arrow colour follows the theme (text-ink-muted)
         * instead of a hardcoded hex baked into a background-image (audit N-02). */}
        <ChevronDown
          size={14}
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
        />
      </div>
    </FieldShell>
  );
});

/* ------------------------------------------------------------------ *
 * Checkbox & Switch
 * ------------------------------------------------------------------ */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  hint?: ReactNode;
  /** Hide the visible text label but keep it for screen readers (T03 / R-01). */
  labelHidden?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, labelHidden, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;

  return (
    <div className={cx('flex items-start gap-2.5', className)}>
      <span className="relative mt-0.5 inline-flex h-4.5 w-4.5 shrink-0">
        <input
          ref={ref}
          id={fieldId}
          type="checkbox"
          className={cx(
            'peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-xs',
            'border border-line-strong bg-surface transition-colors duration-150',
            'hover:border-brand',
            'checked:border-brand checked:bg-brand',
            'focus-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          {...rest}
        />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={cx(
            'pointer-events-none absolute inset-0 m-auto h-3 w-3 text-on-brand',
            'scale-50 opacity-0 transition-all duration-150 ease-spring',
            'peer-checked:scale-100 peer-checked:opacity-100',
          )}
        >
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
      </span>
      <label
        htmlFor={fieldId}
        className={cx(
          labelHidden ? 'sr-only' : 'cursor-pointer select-none text-sm leading-5 text-ink',
        )}
      >
        {label}
        {hint && (
          <span className={cx('block text-xs text-ink-muted', labelHidden ? '' : 'mt-0.5')}>
            {hint}
          </span>
        )}
      </label>
    </div>
  );
});

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  /** Hide the visible text label but keep it for screen readers. */
  labelHidden?: boolean;
}

export function Switch({ checked, onChange, label, hint, disabled, labelHidden }: SwitchProps) {
  const id = useId();

  return (
    <div className="flex items-center justify-between gap-4">
      {!labelHidden && (
        <label htmlFor={id} className="cursor-pointer select-none text-sm text-ink">
          {label}
          {hint && <span className="mt-0.5 block text-xs text-ink-muted">{hint}</span>}
        </label>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={labelHidden ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          // 24×44 touch target. ON = brand track; OFF = recessed sunken track
          // with a strong border so both states read instantly in dark themes.
          'group relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-200',
          'focus-ring-round',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked
            ? 'border-brand bg-brand hover:bg-brand-hover'
            : 'border-line-strong bg-sunken hover:border-brand',
        )}
      >
        <span
          className={cx(
            // Thumb: springs across the track; pressing squishes it wider
            // (group-active:w-5.5) like a physical toggle.
            'absolute top-0.5 flex h-5 w-5 items-center justify-center rounded-full',
            'bg-surface shadow-raised transition-all duration-200 ease-spring',
            'group-active:w-5.5',
            checked
              ? 'translate-x-5.5 border-transparent group-active:translate-x-5'
              : 'translate-x-0.5 border-line-strong',
          )}
        >
          {/* ON mark: brand check pops in */}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={3.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className={cx(
              'absolute h-3 w-3 text-brand transition-all duration-200 ease-spring',
              checked ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
            )}
          >
            <path d="M4 12.5l5 5L20 6.5" />
          </svg>
          {/* OFF mark: faint dot fades out as the check takes over */}
          <span
            aria-hidden
            className={cx(
              'absolute h-1 w-1 rounded-full bg-ink-faint transition-all duration-200',
              checked ? 'scale-50 opacity-0' : 'scale-100 opacity-100',
            )}
          >
          </span>
        </span>
      </button>
    </div>
  );
}

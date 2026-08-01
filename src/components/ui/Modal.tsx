import { useCallback, useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from '@/lib/cx';
import { Button } from './Button';
import { IconButton } from './IconButton';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Nested overlays each add a lock; the scrollbar only returns at zero. */
let scrollLocks = 0;

function lockScroll() {
  if (scrollLocks++ === 0) {
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
  }
}

function unlockScroll() {
  if (--scrollLocks <= 0) {
    scrollLocks = 0;
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }
}

export type ModalSize = 'sm' | 'md' | 'lg' | 'full';

const SIZE: Record<ModalSize, string> = {
  sm: 'md:max-w-md',
  md: 'md:max-w-xl',
  lg: 'md:max-w-3xl',
  full: 'md:max-w-5xl',
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  /** Clicking the backdrop closes by default; turn off for destructive flows. */
  dismissOnBackdrop?: boolean;
  hideCloseButton?: boolean;
  /** Element focused on open. Falls back to the first focusable child. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * One overlay primitive for the whole app.
 *
 * Below the `md` breakpoint it renders as a bottom sheet, above it as a
 * centred dialog. Having a single component means a dialog can never ship
 * with a different close affordance, padding rhythm or escape behaviour than
 * its neighbours — which is exactly how overlay drift starts.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissOnBackdrop = true,
  hideCloseButton = false,
  initialFocusRef,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !panelRef.current) return;

      // Keep focus inside the panel — a dialog you can tab out of is a dialog
      // screen-reader users get lost in.
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null,
      );
      if (nodes.length === 0) return;

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    lockScroll();
    document.addEventListener('keydown', handleKeyDown, true);

    const raf = requestAnimationFrame(() => {
      const target =
        initialFocusRef?.current ??
        panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        panelRef.current;
      target?.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown, true);
      unlockScroll();
      restoreRef.current?.focus?.();
    };
  }, [open, handleKeyDown, initialFocusRef]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6">
      <div
        className="anim-fade absolute inset-0 bg-black/35 backdrop-blur-[2px]"
        onClick={dismissOnBackdrop ? onClose : undefined}
        aria-hidden
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(
          'anim-slide-up md:anim-rise relative flex max-h-[92dvh] w-full flex-col',
          'rounded-t-lg bg-surface shadow-modal outline-none md:rounded-lg',
          SIZE[size],
        )}
      >
        {/* Grab handle — a sheet without one does not read as draggable. */}
        <div className="flex justify-center pt-2 md:hidden" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-line-strong" />
        </div>

        {(title || !hideCloseButton) && (
          <header className="flex items-start gap-3 px-5 pb-3 pt-4 md:pt-5">
            <div className="min-w-0 flex-1">
              {title && (
                <h2 id={titleId} className="truncate text-lg font-semibold text-ink">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="mt-1 text-sm text-ink-soft">
                  {description}
                </p>
              )}
            </div>
            {!hideCloseButton && (
              <IconButton
                label="关闭"
                icon={<X size={17} />}
                onClick={onClose}
                className="-mr-1.5 -mt-1"
              />
            )}
          </header>
        )}

        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>

        {footer && (
          <footer className="pad-safe-b flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  loading?: boolean;
}

/** Thin wrapper so every destructive confirmation looks and behaves alike. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  loading,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dismissOnBackdrop={!loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-soft">{message}</p>
    </Modal>
  );
}

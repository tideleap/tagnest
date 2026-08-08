import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cx } from '@/lib/cx';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
  description?: string;
  /** Milliseconds; `0` keeps it until dismissed. */
  duration: number;
  action?: { label: string; onClick: () => void };
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Math.random().toString(36).slice(2, 10);
    const toast: Toast = { duration: t.tone === 'error' ? 6000 : 3500, ...t, id };
    // Cap the stack — beyond four, the oldest are unreadable anyway.
    set((s) => ({ toasts: [...s.toasts, toast].slice(-4) }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Imperative helper so call sites don't need the hook. */
export const toast = {
  info: (message: string, description?: string) =>
    useToastStore.getState().push({ tone: 'info', message, description }),
  success: (message: string, description?: string) =>
    useToastStore.getState().push({ tone: 'success', message, description }),
  warning: (message: string, description?: string) =>
    useToastStore.getState().push({ tone: 'warning', message, description }),
  error: (message: string, description?: string) =>
    useToastStore.getState().push({ tone: 'error', message, description }),
  action: (message: string, action: { label: string; onClick: () => void }, tone: ToastTone = 'info') =>
    useToastStore.getState().push({ tone, message, action, duration: 8000 }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};

const TONE: Record<ToastTone, { icon: ReactNode; accent: string }> = {
  info: { icon: <Info size={16} />, accent: 'text-ink-soft' },
  success: { icon: <CheckCircle2 size={16} />, accent: 'text-positive' },
  warning: { icon: <AlertTriangle size={16} />, accent: 'text-caution' },
  error: { icon: <XCircle size={16} />, accent: 'text-critical' },
};

function ToastRow({ item }: { item: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    if (item.duration === 0) return;
    const timer = setTimeout(() => dismiss(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, dismiss]);

  return (
    <div
      role="status"
      className="anim-rise pointer-events-auto flex w-full items-start gap-2.5 rounded-md border border-line bg-surface px-3.5 py-3 shadow-overlay"
    >
      <span className={cx('mt-px shrink-0', TONE[item.tone].accent)} aria-hidden>
        {TONE[item.tone].icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-5 text-ink">{item.message}</p>
        {item.description && (
          <p className="mt-0.5 text-xs leading-4 text-ink-soft">{item.description}</p>
        )}
        {item.action && (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              dismiss(item.id);
            }}
            className="mt-1.5 text-xs font-medium text-brand-ink underline-offset-2 hover:underline"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        aria-label="关闭提示"
        className="-mr-1 -mt-0.5 shrink-0 rounded-sm p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/**
 * Mounted once at the app root.
 *
 * On phones it sits bottom-centre but is lifted above the fixed bottom tab
 * bar (bottom-[76px]) so it never covers the nav; on wider screens it drops to
 * the bottom-right corner, out of the reading path.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pad-safe-b pointer-events-none fixed inset-x-0 bottom-[76px] z-[60] flex flex-col items-center gap-2 p-3 sm:inset-x-auto sm:right-0 sm:items-end sm:p-4 md:bottom-0"
    >
      <div className="flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <ToastRow key={t.id} item={t} />
        ))}
      </div>
    </div>
  );
}

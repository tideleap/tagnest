import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/lib/cx';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  trailing?: ReactNode;
  /** Draws a divider above this item. */
  separatorBefore?: boolean;
}

export interface MenuProps {
  /** The button that opens the menu. Receives the props it must spread. */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: (e: React.MouseEvent) => void;
    'aria-expanded': boolean;
    'aria-haspopup': 'menu';
  }) => ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  /** Menu width in pixels; content is truncated rather than wrapped. */
  width?: number;
}

/**
 * Portal-rendered dropdown with roving keyboard focus.
 *
 * Positioned against the trigger's viewport rect and closed on scroll, which
 * avoids both clipping inside `overflow: hidden` ancestors and the stale
 * placement you get from position-once implementations.
 */
export function Menu({ trigger, items, align = 'end', width = 200 }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const enabledIndexes = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const gutter = 8;

    let left = align === 'end' ? rect.right - width : rect.left;
    left = Math.min(Math.max(gutter, left), window.innerWidth - width - gutter);

    const estimatedHeight = items.length * 34 + 12;
    const flipUp = rect.bottom + estimatedHeight + gutter > window.innerHeight;
    const top = flipUp ? Math.max(gutter, rect.top - estimatedHeight - 4) : rect.bottom + 4;

    setPos({ top, left });
  }, [open, align, width, items.length]);

  useEffect(() => {
    if (!open) return;

    const close = () => setOpen(false);

    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((current) => {
          const at = enabledIndexes.indexOf(current);
          const step = e.key === 'ArrowDown' ? 1 : -1;
          const next = (at + step + enabledIndexes.length) % enabledIndexes.length;
          return enabledIndexes[next] ?? -1;
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIndex(enabledIndexes[0] ?? -1);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActiveIndex(enabledIndexes[enabledIndexes.length - 1] ?? -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        const item = items[activeIndex];
        if (item && !item.disabled) {
          e.preventDefault();
          close();
          item.onSelect();
        }
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open, items, activeIndex, enabledIndexes]);

  useEffect(() => {
    // Reset the highlighted item each time the menu opens, regardless of how
    // the enabled list changed while closed.
    if (open) setActiveIndex(enabledIndexes[0] ?? -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset-on-open only
  }, [open]);

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: (e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        },
        'aria-expanded': open,
        'aria-haspopup': 'menu',
      })}

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: pos.top, left: pos.left, width }}
            className="anim-rise fixed z-50 overflow-hidden rounded-xl border border-line bg-surface/95 py-1.5 shadow-overlay backdrop-blur-xl"
          >
            {items.map((item, i) => (
              <div key={item.id}>
                {item.separatorBefore && i > 0 && <div className="my-1.5 mx-3 h-px bg-line" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onMouseEnter={() => !item.disabled && setActiveIndex(i)}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={cx(
                    'relative flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors',
                    'disabled:cursor-not-allowed disabled:opacity-45',
                    item.tone === 'danger' ? 'text-critical-ink' : 'text-ink',
                    activeIndex === i &&
                      !item.disabled &&
                      (item.tone === 'danger' ? 'bg-critical-soft' : 'bg-brand-soft/70'),
                  )}
                >
                  {activeIndex === i && !item.disabled && (
                    <span
                      aria-hidden
                      className={cx(
                        'absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full',
                        item.tone === 'danger' ? 'bg-critical' : 'bg-brand-accent',
                      )}
                    />
                  )}
                  {item.icon && (
                    <span
                      className={cx(
                        'flex shrink-0 transition-colors',
                        activeIndex === i && !item.disabled
                          ? item.tone === 'danger'
                            ? 'text-critical'
                            : 'text-brand-ink'
                          : 'text-ink-faint',
                      )}
                      aria-hidden
                    >
                      {item.icon}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.trailing && (
                    <span className="shrink-0 text-2xs tabular-nums text-ink-faint">{item.trailing}</span>
                  )}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

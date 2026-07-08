import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared modal primitive: a fixed, centered backdrop + panel with dialog semantics
 * (role="dialog", aria-modal, aria-labelledby), a hand-rolled focus trap (focus the
 * panel on mount, cycle Tab within it, restore focus to whatever had it on unmount),
 * and a single consistent z-index. Dismissal (Escape / backdrop click) is opt-in via
 * `onClose` — onboarding-style modals that must not be dismissable can simply omit it.
 */
export function Modal({
  labelledBy,
  onClose,
  closeOnBackdrop = true,
  panelClassName,
  backdropClassName,
  children,
}: {
  /** id of the element (usually a heading) that labels this dialog for a11y. */
  labelledBy: string;
  /** Enables Escape-to-close and (unless disabled) backdrop-click-to-close. Omit to make the modal non-dismissable. */
  onClose?: () => void;
  /** Whether clicking the backdrop closes the modal. Only takes effect when `onClose` is set. */
  closeOnBackdrop?: boolean;
  panelClassName?: string;
  backdropClassName?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Focus the panel on mount, restore whatever had focus before it on unmount.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    };
  }, []);

  // Escape-to-close and Tab-cycling focus trap, both scoped to this panel.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onClose) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className={cn(
        'fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4',
        backdropClassName,
      )}
      onClick={onClose && closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'rounded-2xl border border-border bg-bg shadow-2xl outline-none',
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';
import { t } from '../../lib/i18n';

interface ModalProps {
  /** ReactNode, not just string, so a caller can compose a translated label
   * with a <Foreign>-wrapped server-sourced value (e.g. a team name). */
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** The app's one dialog primitive — `Popover` handles anchored dropdowns,
 * this handles a centered, page-blocking overlay (currently just
 * ManageTeamModal). `role="dialog"` + `aria-modal`, Escape to close, focus
 * moved in on open and restored to whatever triggered it on close, and a
 * simple Tab/Shift-Tab trap so keyboard focus can't leak behind the
 * overlay. */
export function Modal({ title, onClose, children }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Lock the page's own scroll while the dialog is open, compensating for
    // the vanished scrollbar so the page doesn't reflow sideways — without
    // this, background scroll fights the dialog's internal scroll and the
    // page can jump under the user's cursor.
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;

    triggerRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const [firstEl] = focusable;
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
      triggerRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rendered via a portal straight into document.body: the app shell
  // (Layout.tsx) has `backdrop-blur-xl` on an ancestor, and backdrop-filter
  // (like filter/transform) establishes a new containing block for
  // `position: fixed` descendants — so without the portal, this dialog was
  // positioning itself relative to that tall scrolling wrapper instead of
  // the viewport, and could render below the fold with no way to scroll to
  // it (the dialog itself locks body scroll).
  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/25 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* max-h, not a fixed h: the dialog grows with its content and stops at
          85vh, so a three-team chart doesn't render two-thirds of an empty
          panel. The body below still scrolls once content exceeds that. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-lg"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-ink">
            {title}
          </h2>
          <IconButton aria-label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

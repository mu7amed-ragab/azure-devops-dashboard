import { useEffect, useRef, useState } from 'react';

/** Shared open/close + click-outside + Escape wiring for every anchored
 * popover in this app (state picker, sprint-mismatch chip, story-level bulk
 * move, the View/Type menus, the account menu). Each caller owns its own
 * trigger/panel markup — only the interaction plumbing is shared, so drift
 * between hand-rolled click-outside effects becomes impossible. */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  return { open, setOpen, rootRef };
}

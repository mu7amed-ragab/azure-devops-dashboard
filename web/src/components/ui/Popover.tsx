import type { HTMLAttributes, ReactNode } from 'react';

interface PopoverPanelProps extends HTMLAttributes<HTMLDivElement> {
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
}

/** The one radius/shadow/z-index treatment for every dropdown/popover panel
 * in the app (state picker, sprint-mismatch chip, story bulk-move, View/Type
 * menus, account menu) — pair with `usePopover` from lib/usePopover.ts for
 * the open/close/click-outside/Escape plumbing. */
export function PopoverPanel({ align = 'right', className = '', children, ...props }: PopoverPanelProps) {
  return (
    <div
      className={`absolute z-popover mt-1 rounded-card border border-border bg-surface-raised shadow-lg ${
        align === 'right' ? 'end-0' : 'start-0'
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}


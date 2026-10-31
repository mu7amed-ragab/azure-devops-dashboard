import type { ReactNode } from 'react';

interface ToolbarProps {
  'aria-label': string;
  children: ReactNode;
  className?: string;
  /** Lays children out as explicit stacked rows (search/actions on top,
   * filter chips below) instead of one `flex-wrap` row that only splits
   * incidentally once enough chips crowd it. Pair with `ToolbarRow`. */
  stacked?: boolean;
}

/** The filter-bar shell shared by every list/page toolbar (Work Items, Pull
 * Requests, Dashboard, Team) — previously 4 verbatim-identical copies, one
 * of which (Team) was missing the `role`/`aria-label` this now enforces on
 * every call site. */
export function Toolbar({ children, className = '', stacked = false, ...props }: ToolbarProps) {
  return (
    <div
      role="group"
      className={`flex rounded-card border border-border bg-surface-raised px-3 py-2.5 ${
        stacked ? 'flex-col items-stretch gap-2' : 'flex-wrap items-center gap-3'
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

/** One row within a `stacked` `Toolbar` — still wraps internally if its own
 * contents overflow, it just no longer wraps *across* the search input and
 * the filter chips. */
export function ToolbarRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-3 ${className}`}>{children}</div>;
}

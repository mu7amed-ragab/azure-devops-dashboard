import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface StatTileProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  tone?: 'default' | 'warn' | 'danger' | 'accent';
  /** When present, the whole tile links there (e.g. a Work Items view
   * drill-down) instead of being a plain display card. */
  to?: string;
  /** When present instead of `to`, the tile is a button that calls this on
   * click — for the Team page, where the drill-down applies as local state
   * to the embedded WorkItemsView rather than navigating anywhere. */
  onClick?: () => void;
  /** Tooltip text — used to note when a tile's number deliberately overlaps
   * another tile's (e.g. tasks-in-progress includes blocked tasks). */
  title?: string;
  /** True when this tile's drill-down is the one currently applied — only
   * meaningful for the `onClick` form, where the result renders in place
   * rather than navigating, so the tile itself is the only indication of
   * which filter is active. */
  active?: boolean;
}

// warn measured 2.06:1 on the raised surface (light) — well under the 3:1
// floor for large text; the --warning token (amber-700-equivalent) clears
// it at 4.81:1. danger technically passed at 3.52:1 but --danger (rose-700-
// equivalent) gives real margin instead of sitting right at the line. Both
// tokens swap to their already-safe -400 shade under .dark automatically,
// so no separate dark: variant is needed here.
const TONE_CLASSES: Record<NonNullable<StatTileProps['tone']>, string> = {
  default: 'text-ink',
  warn: 'text-warning',
  danger: 'text-danger',
  accent: 'text-accent',
};

export function StatTile({ label, value, icon, tone = 'default', to, onClick, title, active }: StatTileProps) {
  const isInteractive = !!to || !!onClick;
  const className = `flex min-w-[9.5rem] flex-1 shrink-0 flex-col gap-1 rounded-card border px-4 py-3 snap-start ${
    active ? 'border-accent bg-accent/15' : 'border-border bg-surface-raised'
  } ${
    isInteractive
      ? active
        ? 'focus-ring cursor-pointer transition-colors hover:border-accent'
        : 'focus-ring cursor-pointer transition-colors hover:border-accent/40 hover:bg-surface-sunken'
      : ''
  }`;

  const content = (
    <>
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        {icon}
        <span>{label}</span>
      </div>
      <span className={`text-2xl font-semibold tabular-nums ${TONE_CLASSES[tone]}`}>{value}</span>
    </>
  );

  if (to) {
    return (
      <Link to={to} className={className} title={title}>
        {content}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${className} text-start`} title={title} aria-pressed={active}>
        {content}
      </button>
    );
  }

  return (
    <div className={className} title={title}>
      {content}
    </div>
  );
}


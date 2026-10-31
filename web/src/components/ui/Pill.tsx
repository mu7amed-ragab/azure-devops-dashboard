import type { HTMLAttributes, ReactNode } from 'react';

export type PillTone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'story'
  | 'task'
  | 'bug'
  | 'sprint'
  | 'approved'
  | 'review'
  | 'staging'
  | 'intake';

/** Complete literal strings — Tailwind's JIT scanner can't see classes
 * assembled by interpolating a token name into a template, so nothing here
 * may be built from a variable (same rule as lib/typeTheme.ts). */
const TONE_CLASSES: Record<PillTone, string> = {
  neutral: 'bg-ink/10 text-ink-muted',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success-tint/15 text-success',
  warning: 'bg-warning-tint/15 text-warning',
  danger: 'bg-danger-tint/15 text-danger',
  info: 'bg-info-tint/15 text-info',
  story: 'bg-type-story/15 text-type-story',
  task: 'bg-type-task/15 text-type-task',
  bug: 'bg-type-bug/15 text-type-bug',
  sprint: 'bg-type-sprint/15 text-type-sprint',
  approved: 'bg-stage-approved/15 text-stage-approved',
  review: 'bg-stage-review/15 text-stage-review',
  staging: 'bg-stage-staging/15 text-stage-staging',
  intake: 'bg-stage-intake/15 text-stage-intake',
};

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  /** 'interactive' bumps py-0.5 to py-1, bringing the tap target to ~24px
   * tall (the WCAG 2.2 AA floor for pointer targets) without changing the
   * visual icon/text size — the audit confirmed this rule already holds
   * with zero exceptions across the codebase, so it's codified here rather
   * than repeated per call site. */
  interactive?: boolean;
  className?: string;
  children: ReactNode;
}

export function Pill({ tone = 'neutral', interactive, className = '', children, ...props }: PillProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium ${
        interactive ? 'py-1' : 'py-0.5'
      } ${TONE_CLASSES[tone]} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}

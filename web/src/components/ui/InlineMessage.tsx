import type { ReactNode } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface InlineMessageProps {
  tone: 'error' | 'success' | 'warning';
  children: ReactNode;
  detail?: ReactNode;
  className?: string;
}

/** Replaces 4 copy-pasted inline-error blocks and the task-edit success
 * banner, none of which announced themselves to assistive tech — this adds
 * the `role` the ad-hoc copies all lacked.
 *
 * `warning` is for a consequence the user is about to accept, not a failure:
 * it reads as a statement with weight rather than a rejection, and announces
 * politely (`role="status"`) because it accompanies a confirm button the user
 * is already reading, not an error that interrupted them.
 *
 * `detail` is optional secondary text (e.g., untranslated upstream error) rendered
 * in a visually subordinate style, used for ADO_ERROR/RATE_LIMITED to show the
 * upstream Azure DevOps text beneath a translated lead sentence. */
export function InlineMessage({ tone, children, detail, className = '' }: InlineMessageProps) {
  if (tone === 'warning') {
    return (
      <p role="status" className={`flex items-start gap-1.5 text-xs text-warning ${className}`}>
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{children}</span>
      </p>
    );
  }
  if (tone === 'success') {
    return (
      <div
        role="status"
        className={`flex items-center gap-1.5 rounded-card border border-success-tint/30 bg-success-tint/10 p-2.5 text-xs font-medium text-success ${className}`}
      >
        <CheckCircle2 size={14} className="shrink-0" />
        {children}
      </div>
    );
  }
  return (
    <div role="alert" className={`flex items-start gap-1.5 ${className}`}>
      <AlertCircle size={14} className="mt-0.5 shrink-0 text-danger" />
      <div className="flex flex-col gap-1">
        <p className="text-xs text-danger">{children}</p>
        {detail && (
          <p className="text-xs text-ink-muted whitespace-pre-wrap">{detail}</p>
        )}
      </div>
    </div>
  );
}

import type { ReactNode } from 'react';
import { Loader2, RefreshCcw } from 'lucide-react';
import { useTranslation } from '../lib/i18n';

export function LoadingView({ label }: { label?: string }) {
  const t = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-ink-subtle" role="status" aria-live="polite">
      <Loader2 size={20} className="animate-spin" aria-hidden="true" />
      <p className="text-sm">{label ?? t('common.loading')}</p>
    </div>
  );
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-border bg-surface-raised py-16 text-center" role="alert">
      <p className="max-w-sm text-sm text-ink-muted">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="focus-ring flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-accent/50"
        >
          <RefreshCcw size={14} /> {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function EmptyView({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-card border border-dashed border-border py-16 text-center text-sm text-ink-subtle">
      {children}
    </div>
  );
}

/** A single inline "still working" row — for ordinary loading (a search
 * settling, a page fetching) where a percentage progress bar would be
 * meaningless. `SyncProgressNotice` is reserved for a genuine first-sync
 * wait, where the server actually reports a phase and a percentage. */
export function InlineSpinner({ label }: { label?: string }) {
  const t = useTranslation();
  return (
    <p className="flex items-center gap-2 py-2 text-xs text-ink-subtle" role="status" aria-live="polite">
      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      {label ?? t('common.loading')}
    </p>
  );
}

/** Reserves the real layout shape while the dashboard's first sync is still
 * running, instead of a bare centered spinner — avoids the layout jump when
 * data lands and reads as faster for a data-dense page like this one. */
function Bone({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-card bg-surface-sunken ${className}`} />;
}

export function DashboardSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-6" role="status" aria-live="polite" aria-label={label}>
      <div className="flex gap-2 overflow-x-hidden pb-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <Bone key={i} className="h-[68px] min-w-[9.5rem] flex-1 shrink-0" />
        ))}
      </div>
      <Bone className="h-[164px]" />
      <div className="space-y-2">
        <Bone className="h-12" />
        <Bone className="h-12" />
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

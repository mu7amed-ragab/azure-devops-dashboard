import { ProgressBar } from './ProgressBar';
import { useSyncProgress } from '../lib/useSyncProgress';
import { useTranslation } from '../lib/i18n';
import type { SyncPhase } from '../lib/types';

interface SyncProgressNoticeProps {
  /** null loads the PAT owner's own progress. */
  personId: string | null;
  /** Only polls while true — caller decides when a sync is actually running
   * (no cached data yet, or the cached data is `partial`). */
  enabled: boolean;
  /** Shown before the server has reported any progress yet. */
  fallbackLabel: string;
}

/** Maps a sync phase id to its catalog key — see server/sync.js's
 * SYNC_STEPS for the id list this must stay in sync with. */
const PHASE_KEY: Record<SyncPhase, 'sync.shared' | 'sync.query' | 'sync.hydrate' | 'sync.prs' | 'sync.history' | 'sync.assemble'> = {
  shared: 'sync.shared',
  query: 'sync.query',
  hydrate: 'sync.hydrate',
  prs: 'sync.prs',
  history: 'sync.history',
  assemble: 'sync.assemble',
};

/** A phase label + percentage bar for an in-progress sync — used both while
 * waiting on the very first sync (no data at all) and while a `partial`
 * payload (server/sync.js's fast 14-day first pass) is being replaced by the
 * full one. `pct` is a weighted estimate (see server/sync.js SYNC_STEPS),
 * not a literal request count — it will visibly stall during a cold shared
 * revision-index rebuild, which is why the label carries page-count detail
 * during that phase instead of staying generic.
 *
 * Localized by `phase` id (T032, contracts/error-details.md), with the
 * server's own English `label` as the fallback for an unrecognized phase —
 * no server change needed since the phase id list is closed and mirrored
 * here. */
export function SyncProgressNotice({ personId, enabled, fallbackLabel }: SyncProgressNoticeProps) {
  const t = useTranslation();
  const progress = useSyncProgress(personId, enabled);
  const pct = progress?.pct ?? 0;
  const phaseKey = progress ? PHASE_KEY[progress.phase] : null;
  const label = phaseKey ? t(phaseKey) : progress?.label ?? fallbackLabel;

  return (
    <div className="space-y-1.5 rounded-card border border-border bg-surface-sunken px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-ink-muted">{label}</span>
        <span className="text-xs tabular-nums text-ink-subtle">{pct}%</span>
      </div>
      <ProgressBar pct={pct} size="sm" />
    </div>
  );
}

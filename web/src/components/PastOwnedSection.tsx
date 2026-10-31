import { History } from 'lucide-react';
import type { PastOwnedResult } from '../lib/types';
import { TaskCard } from './TaskCard';
import { useTranslation } from '../lib/i18n';
import { Foreign } from './ui/Foreign';
import { Pill } from './ui/Pill';
import { AccentBar } from './ui/AccentBar';

interface PastOwnedSectionProps {
  results: PastOwnedResult[];
  truncated: boolean;
  isPending: boolean;
  org: string;
  project: string;
}

/**
 * The past-owned half of a work-item search (US1) — a section below the
 * normal results so current-ownership matches sort first (FR-004) and so
 * this list is trivially told apart from them (SC-003). Never contributes to
 * `stateCounts`/`allItemsCount`/`viewCounts`/`combinedProgress` — it isn't
 * wired into any of them, by construction (research.md R2, data-model.md §6.3).
 *
 * Reuses TaskCard with `isSelf={false}`, which already suppresses every edit
 * affordance (the pencil, the state dropdown, TaskEditPanel) — the read-only
 * rendering is the courtesy; `assertAssignedTo` server-side is the real
 * enforcement (a past-owned item fails that check by definition).
 */
export function PastOwnedSection({ results, truncated, isPending, org, project }: PastOwnedSectionProps) {
  const t = useTranslation();

  if (!isPending && results.length === 0) {
    return (
      <div className="relative rounded-card border border-border ps-4 pe-3 py-3">
        <AccentBar tone="neutral" />
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <History size={16} className="shrink-0 text-ink-subtle" />
          {t('pastOwned.heading', { count: 0 })}
        </div>
        <p className="mt-1 text-xs text-ink-subtle">{t('pastOwned.empty')}</p>
      </div>
    );
  }

  return (
    <div className="relative rounded-card border border-border ps-4 pe-3 py-3">
      <AccentBar tone="neutral" />
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        <History size={16} className="shrink-0 text-ink-subtle" />
        {t('pastOwned.heading', { count: results.length })}
        {isPending && <span className="text-xs font-normal text-ink-subtle">{t('pastOwned.pending')}</span>}
      </div>

      {results.length > 0 && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {results.map(({ item, currentAssignee }) => (
            <div key={item.id} className="space-y-1.5">
              <TaskCard task={item} org={org} project={project} isSelf={false} />
              <Pill tone="neutral" className="ms-1">
                {currentAssignee ? (
                  <>
                    <span>{t('pastOwned.currentAssigneePrefix')}</span>
                    <Foreign as="span">{currentAssignee}</Foreign>
                  </>
                ) : (
                  t('pastOwned.currentlyUnassigned')
                )}
              </Pill>
            </div>
          ))}
        </div>
      )}

      {truncated && <p className="mt-2 text-xs text-ink-subtle">{t('pastOwned.truncated')}</p>}
    </div>
  );
}

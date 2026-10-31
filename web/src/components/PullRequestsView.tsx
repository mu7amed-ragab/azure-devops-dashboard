import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, X } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { PrRepoList } from './PrRepoList';
import { FilterChips } from './FilterChips';
import { Toolbar, ToolbarRow } from './ui/Toolbar';
import { SearchInput } from './ui/SearchInput';
import { PR_STATUS_OPTIONS, type PrStatusId } from '../lib/prStatus';
import type { PrRepoSummary } from '../lib/types';

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

interface PullRequestsViewProps {
  /** null for the signed-in person's own PRs. */
  personId: string | null;
  org: string;
  project: string;
  prRepos: PrRepoSummary[];
  isSelf: boolean;
  personDisplayName: string;
  /** A status locked in by the caller — the Dashboard stat tile's
   * `?status=` link, or the Team page's "Open pull requests" tile jumping
   * to this tab pre-filtered to Active. Shown as a dismissible banner
   * (dismissible only when `onClearForcedStatus` is given); mutually
   * exclusive with the status chips below — picking one clears the other. */
  forcedStatus?: string | null;
  onClearForcedStatus?: () => void;
}

/** The full Pull Requests experience — search, status chips, expand/
 * collapse-all, and the repo-accordion list — extracted from the Pull
 * Requests page so the Team page can mount the exact same thing scoped to
 * one teammate. */
export function PullRequestsView({
  personId,
  org,
  project,
  prRepos,
  isSelf,
  personDisplayName,
  forcedStatus = null,
  onClearForcedStatus,
}: PullRequestsViewProps) {
  const t = useTranslation();
  // Session-only — a stale search surviving a reload is confusing, not
  // convenient.
  const [search, setSearch] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set());
  const [expandSignal, setExpandSignal] = useState(0);
  const [collapseSignal, setCollapseSignal] = useState(0);

  const trimmedSearch = search.trim();
  const q = useDebouncedValue(trimmedSearch, 300);
  const isSearching = q !== '';
  const isFiltering = selectedStatuses.size > 0 || !!forcedStatus;

  // A caller-forced status (Dashboard/Team stat tile) and the page's own
  // filters (search, status chips) are mutually exclusive — same "last one
  // wins" rule as the Work Items view, rather than ANDing them together into
  // a combination that can contradict itself and match nothing.
  function handleSearchChange(next: string) {
    setSearch(next);
    if (next.trim() !== '' && forcedStatus) onClearForcedStatus?.();
  }

  function toggleStatus(id: string) {
    if (forcedStatus) onClearForcedStatus?.();
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Seeded to null so a mount that already carries a forced status (arriving
  // straight from a stat tile) counts as a transition too, not just a later
  // change while mounted.
  const previousForcedStatus = useRef<string | null>(null);
  useEffect(() => {
    if (forcedStatus && forcedStatus !== previousForcedStatus.current) {
      setSearch('');
      setSelectedStatuses(new Set());
    }
    previousForcedStatus.current = forcedStatus;
  }, [forcedStatus]);

  // Status counts come straight off `prRepos` — computed server-side over
  // the full windowed PR set with zero attribution cost, so these are
  // always exact, never limited to whatever pages happen to be loaded.
  const statusOptions = useMemo(() => {
    const counts: Record<PrStatusId, number> = { active: 0, draft: 0, completed: 0, abandoned: 0 };
    for (const repo of prRepos) {
      counts.active += repo.statusCounts.active;
      counts.draft += repo.statusCounts.draft;
      counts.completed += repo.statusCounts.completed;
      counts.abandoned += repo.statusCounts.abandoned;
    }
    return PR_STATUS_OPTIONS.map((o) => ({ id: o.id, label: t(`pr.status.${o.id}`), count: counts[o.id] }));
  }, [prRepos, t]);

  // The effective set of allowed statuses — `forcedStatus` and the chip Set
  // never coexist (see the reset effect above), so this is just "whichever
  // one is active", never an intersection of the two.
  const allowedStatuses = useMemo(() => {
    if (forcedStatus) return new Set([forcedStatus]);
    if (selectedStatuses.size > 0) return new Set(selectedStatuses);
    return new Set(PR_STATUS_OPTIONS.map((o) => o.id));
  }, [forcedStatus, selectedStatuses]);
  const status = allowedStatuses.size < PR_STATUS_OPTIONS.length ? [...allowedStatuses].join(',') : null;

  const totalPrCount = useMemo(() => prRepos.reduce((n, r) => n + r.prCount, 0), [prRepos]);
  const visibleByStatus = useMemo(() => {
    if (!status) return totalPrCount;
    return [...allowedStatuses].reduce((n, s) => n + (statusOptions.find((o) => o.id === s)?.count ?? 0), 0);
  }, [status, allowedStatuses, statusOptions, totalPrCount]);
  // A search's true match count isn't known without querying, so the header
  // total is left unfiltered while searching — each repo section's own
  // header count still reflects the search once its match count loads.
  const countLabel =
    !isSearching && visibleByStatus !== totalPrCount
      ? t('pr.countLabelFiltered', { count: totalPrCount, visible: visibleByStatus, total: totalPrCount })
      : t('pr.countLabel', { count: totalPrCount });

  const isFilteredView = isFiltering || isSearching;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-ink-subtle tabular-nums">{countLabel}</span>
      </div>

      {forcedStatus && (
        <div
          role="group"
          aria-label={t('pr.activeStatusFilterAriaLabel')}
          className="flex items-center gap-2 rounded-card border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-medium text-accent"
        >
          <span>
            {t('pr.showing', { label: statusOptions.find((o) => o.id === forcedStatus)?.label ?? forcedStatus, count: visibleByStatus })}
          </span>
          {onClearForcedStatus && (
            <button
              type="button"
              onClick={onClearForcedStatus}
              className="focus-ring ms-auto flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-accent transition-colors hover:bg-accent/15"
              aria-label={t('pr.clearAppliedFilterAriaLabel')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      <Toolbar aria-label={t('pr.listControlsAriaLabel')} stacked>
        <ToolbarRow>
          <SearchInput
            value={search}
            onChange={handleSearchChange}
            placeholder={t('prList.searchPlaceholder')}
            maxWidth={280}
          />
        </ToolbarRow>

        <ToolbarRow>
          <FilterChips
            options={statusOptions}
            selected={selectedStatuses}
            onToggle={toggleStatus}
            onClear={() => {
              if (forcedStatus) onClearForcedStatus?.();
              setSelectedStatuses(new Set());
            }}
            allCount={totalPrCount}
          />
        </ToolbarRow>

        <ToolbarRow className="justify-end">
          <button
            type="button"
            onClick={() => setExpandSignal((v) => v + 1)}
            className="focus-ring flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
            title={t('pr.expandAll')}
          >
            <ChevronsUpDown size={14} />
            <span>{t('pr.expandAll')}</span>
          </button>
          <button
            type="button"
            onClick={() => setCollapseSignal((v) => v + 1)}
            className="focus-ring flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
            title={t('pr.collapseAll')}
          >
            <ChevronsDownUp size={14} />
            <span>{t('pr.collapseAll')}</span>
          </button>
        </ToolbarRow>
      </Toolbar>

      <PrRepoList
        personId={personId}
        org={org}
        project={project}
        prRepos={prRepos}
        status={status}
        q={q}
        isFilteredView={isFilteredView}
        emptyMessage={
          isFilteredView
            ? t('prList.noMatchFiltered')
            : isSelf
              ? t('prList.emptyForSelf')
              : t('prList.emptyForPerson', { name: personDisplayName })
        }
        expandSignal={expandSignal}
        collapseSignal={collapseSignal}
      />
    </div>
  );
}


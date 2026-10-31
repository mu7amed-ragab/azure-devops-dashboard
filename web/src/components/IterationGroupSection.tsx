import { useEffect, useRef } from 'react';
import { ChevronRight, Pin, PinOff } from 'lucide-react';
import { DirectionalIcon } from './ui/DirectionalIcon';
import type { IterationGroup } from '../lib/types';
import { StoryCard } from './StoryCard';
import { TaskCard } from './TaskCard';
import { formatDate, formatHours } from '../lib/format';
import { useLang } from '../lib/i18n/useLang';
import { useTranslation } from '../lib/i18n';
import { SPRINT_THEME } from '../lib/typeTheme';
import { usePersistedState } from '../lib/persistedState';
import { AccentBar } from './ui/AccentBar';
import { Pill } from './ui/Pill';
import { Foreign } from './ui/Foreign';

interface IterationGroupSectionProps {
  group: IterationGroup;
  org: string;
  project: string;
  isSelf?: boolean;
  /** Persists this section's open/closed state under this key, namespaced
   * per scope + sprint by the caller (see WorkItemsView). */
  persistKey: string;
  /** Whether this sprint is the current one — manually pinned, or the
   * sprint whose date range contains today when nothing's been pinned. See
   * lib/currentSprint.ts. */
  isCurrent: boolean;
  /** Whether this sprint is current because it was *manually pinned*, as
   * opposed to being today's sprint by date. Only the pin control reads it,
   * so the toggle offers "unpin" only when there's a pin to remove.
   * Defaults to `isCurrent`. */
  isPinned?: boolean;
  /** Marks/unmarks this sprint as current (toggle) — omitted for the
   * unscheduled "No sprint" bucket, which isn't a real sprint. */
  onMarkCurrent?: () => void;
  forceExpandStoryIds?: Set<number>;
  selectMode?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  expandSignal?: number;
  collapseSignal?: number;
  /** Collapses this section the moment a filter/search is applied — distinct
   * from `collapseSignal` (the toolbar's manual "Collapse all", which also
   * collapses every story inside via `storyCollapseSignal`) so filtering
   * closes sprint sections without also closing a story that matched via a
   * child task. See WorkItemsView's `filterCollapseSignal`. */
  autoCollapseSignal?: number;
  storyExpandSignal?: number;
  storyCollapseSignal?: number;
}

export function IterationGroupSection({
  group,
  org,
  project,
  isSelf = true,
  persistKey,
  isCurrent,
  isPinned = isCurrent,
  onMarkCurrent,
  forceExpandStoryIds,
  selectMode,
  selectedIds,
  onToggleSelect,
  expandSignal,
  collapseSignal,
  autoCollapseSignal,
  storyExpandSignal,
  storyCollapseSignal,
}: IterationGroupSectionProps) {
  useLang((s) => s.lang); // subscribe so formatDate()/formatHours() below re-render on language switch
  const t = useTranslation();
  const [open, setOpen] = usePersistedState(persistKey, isCurrent);

  // The stored `open` value already won at seed time, so becoming current
  // later needs an explicit open — but only on that transition, not on
  // every render (a sprint the user closed while it was current should stay
  // closed on remount, and losing "current" status shouldn't auto-close it).
  const wasCurrent = useRef(isCurrent);
  useEffect(() => {
    if (isCurrent && !wasCurrent.current) setOpen(true);
    wasCurrent.current = isCurrent;
  }, [isCurrent]);

  useEffect(() => { if (expandSignal) setOpen(true); }, [expandSignal]);
  useEffect(() => { if (collapseSignal) setOpen(false); }, [collapseSignal]);
  useEffect(() => { if (autoCollapseSignal) setOpen(false); }, [autoCollapseSignal]);

  // Includes crossSprintItems — they render as real rows in this section
  // (below), so this sprint's own "N items" label should count them. This is
  // distinct from WorkItemsView's page-wide visibleCount/totalCount, which
  // counts by distinct work item id so a promoted entry adds a row but never
  // a second count there (FR-019) — see WorkItemsView.tsx.
  const itemCount = group.stories.length + group.unparentedItems.length + group.crossSprintItems.length;

  return (
    <div className={`relative rounded-card border ${SPRINT_THEME.border}`}>
      <div className={`flex items-center gap-1 rounded-card ps-5 ${SPRINT_THEME.tint}`}>
        <AccentBar tone={SPRINT_THEME.accentTone} />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="focus-ring flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 rounded-card py-3 pe-2 text-start"
          aria-expanded={open}
        >
          <div className="flex min-w-0 items-center gap-2">
            <DirectionalIcon>
              <ChevronRight size={16} className={`shrink-0 text-ink-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
            </DirectionalIcon>
            <Foreign as="span" className="truncate text-sm font-semibold text-ink">{group.iterationName}</Foreign>
            {isCurrent && <Pill tone="accent">{t('workitems.currentSprintPill')}</Pill>}
            {group.isLatest && !isCurrent && <Pill tone="neutral">{t('workitems.latestSprintPill')}</Pill>}
            {group.startDate && group.finishDate && (
              <span className="hidden shrink-0 text-xs text-ink-subtle sm:inline">
                {formatDate(group.startDate)} – {formatDate(group.finishDate)}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs text-ink-muted tabular-nums">
            <span>{t('workitems.itemCount', { count: itemCount })}</span>
            <span>{t('workitems.hoursProgress', { completed: formatHours(group.hours.completed), estimated: formatHours(group.hours.estimated) })}</span>
          </div>
        </button>
        {onMarkCurrent && (
          <button
            type="button"
            onClick={onMarkCurrent}
            aria-label={t(isPinned ? 'workitems.unmarkCurrentSprint' : 'workitems.markCurrentSprint', { name: group.iterationName })}
            title={t(isPinned ? 'workitems.unmarkCurrentSprint' : 'workitems.markCurrentSprint', { name: group.iterationName })}
            className={`focus-ring me-2 flex shrink-0 cursor-pointer items-center justify-center rounded-full p-1.5 transition-colors ${
              isCurrent ? 'text-accent hover:bg-accent/15' : 'text-ink-subtle hover:bg-surface-sunken hover:text-ink'
            }`}
          >
            {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        )}
      </div>

      {open && (
        <div className="space-y-2 p-3">
          {group.stories.map((story) => (
            <StoryCard
              key={story.id}
              story={story}
              org={org}
              project={project}
              isSelf={isSelf}
              forceExpanded={forceExpandStoryIds?.has(story.id)}
              selectMode={selectMode}
              selected={selectedIds?.has(story.id)}
              onToggleSelect={() => onToggleSelect?.(story.id)}
              expandSignal={storyExpandSignal}
              collapseSignal={storyCollapseSignal}
            />
          ))}

          {group.unparentedItems.length > 0 && (
            <div className="space-y-2 pt-1">
              <p className="text-xs font-medium text-ink-subtle">
                {t('workitems.unparented', { count: group.unparentedItems.length })}
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.unparentedItems.map((item) => (
                  <TaskCard
                    key={item.id}
                    task={item}
                    org={org}
                    project={project}
                    isSelf={isSelf}
                    selectMode={selectMode}
                    selected={selectedIds?.has(item.id)}
                    onToggleSelect={() => onToggleSelect?.(item.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {group.crossSprintItems.length > 0 && (
            <div className="space-y-2 pt-1">
              <p className="text-xs font-medium text-ink-subtle">
                {t('workitems.fromAnotherSprint', { count: group.crossSprintItems.length })}
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.crossSprintItems.map((item) => (
                  // Deliberately no parentIterationPath here — that prop is
                  // what triggers SprintMismatchChip inside TaskCard, and
                  // "still on {this sprint}" would be exactly wrong on a card
                  // sitting inside this sprint's own section. task.parentRef
                  // (always set on a promoted entry) drives ParentSprintRef
                  // instead. See contracts/dashboard-payload.md, Client
                  // obligations.
                  <TaskCard key={item.id} task={item} org={org} project={project} isSelf={isSelf} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}



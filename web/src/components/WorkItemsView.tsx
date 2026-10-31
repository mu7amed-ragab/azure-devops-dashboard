import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, SlidersHorizontal, X } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { StoryCard } from './StoryCard';
import { TaskCard } from './TaskCard';
import { IterationGroupSection } from './IterationGroupSection';
import { PastOwnedSection } from './PastOwnedSection';
import { Menu } from './Menu';
import { FilterChips } from './FilterChips';
import { LoadingView, ErrorView, EmptyView } from './StatusView';
import { Toolbar, ToolbarRow } from './ui/Toolbar';
import { SearchInput } from './ui/SearchInput';
import { formatHours } from '../lib/format';
import { usePersistedState, usePersistedSet } from '../lib/persistedState';
import { useCurrentSprintStore, isCurrentGroup, orderGroups, resolveCurrentPath } from '../lib/currentSprint';
import { VIEWS, countFor, type ViewId } from '../lib/workItemViews';
import { buildRecentTree, buildRecentGroups } from '../lib/recentTree';
import { useWorkItemSearch } from '../lib/useWorkItemSearch';
import type { Dashboard, Story, Task } from '../lib/types';

function textMatches(item: { id: number; title: string }, q: string): boolean {
  return item.id.toString().includes(q) || item.title.toLowerCase().includes(q);
}

/** Work items matching a search query (ID fragment or title text): matched
 * directly on the story/item itself, or indirectly via a child task inside
 * it (in which case that task's parent story should auto-expand to reveal
 * it). */
function matchesSearch(story: Story, q: string): { matches: boolean; viaTask: boolean } {
  if (textMatches(story, q)) return { matches: true, viaTask: false };
  const viaTask = story.tasks.some((t) => textMatches(t, q));
  return { matches: viaTask, viaTask };
}

interface WorkItemsViewProps {
  data: Dashboard | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  /** Defaults to "Work Items" — override for an embedded context (e.g. the
   * Team page, where the surrounding section already names the person). */
  heading?: string;
  /** Hides the heading row entirely, for a context that already has its
   * own header (the Team page's per-person section). */
  showHeading?: boolean;
  /** Namespaces persisted filters/search/expand state to whoever's list this
   * is — 'self' for the Work Items page, a person id for a Team member
   * section — so filtering one teammate's embedded list never leaks into
   * another's or into your own Work Items page. */
  scope: string;
  /** The drill-down applied from a Dashboard stat tile — reproduces that
   * tile's exact number by applying the same predicate here. Not URL-only:
   * the Team page mounts this view with no navigation available, so the
   * caller owns where this state lives (URL param vs local state). */
  view?: ViewId | null;
  onViewChange?: (view: ViewId | null) => void;
  /** 'recent' reshapes `data.recentItems` into the same story→tasks /
   * standalone shape 'workitems' reads from `data.stories`/`data.groups` —
   * see lib/recentTree.ts. Lets the Dashboard's "Recently updated" section
   * reuse this exact list engine (search, filters, expand/collapse)
   * instead of its own bespoke rendering. */
  source?: 'workitems' | 'recent';
}

/** The Work Items list — search, state filter, group-by-sprint toggle,
 * cumulative progress selection — extracted from the Work Items page so it
 * can also be mounted per-person on the Team page. Purely presentational:
 * takes a `Dashboard` (or its loading/error state) and renders it; the
 * caller owns which person's data that is. */
export function WorkItemsView({
  data,
  isLoading,
  isError,
  refetch,
  heading,
  showHeading = true,
  scope,
  view = null,
  onViewChange,
  source = 'workitems',
}: WorkItemsViewProps) {
  const t = useTranslation();
  const [selectedStates, setSelectedStates] = usePersistedSet<string>(`workitems:${scope}:states`);
  const [groupByIteration, setGroupByIteration] = usePersistedState(`workitems:${scope}:group-by-iteration`, true);
  // Session-only, unlike the other filters — a stale query surviving a
  // reload is confusing, not convenient.
  const [search, setSearch] = useState('');
  const [selectMode, setSelectMode] = usePersistedState(`workitems:${scope}:select-mode`, false);
  const [selectedIds, setSelectedIds] = usePersistedSet<number>(`workitems:${scope}:selected-ids`);
  const [expandSignal, setExpandSignal] = useState(0);
  const [collapseSignal, setCollapseSignal] = useState(0);
  const markedSprintPath = useCurrentSprintStore((s) => s.path);
  const setCurrentSprint = useCurrentSprintStore((s) => s.setCurrent);

  const trimmedSearch = search.trim();
  const q = trimmedSearch.toLowerCase();
  const isSearching = trimmedSearch !== '';

  // US1 (past ownership) — a SEPARATE query entry from the dashboard
  // (research.md R2): nothing below reads `pastOwned`, so the unsearched
  // view and every one of the counts computed further down are untouched by
  // construction. `data?.isSelf` doubles as "has data loaded yet" here —
  // before that, personId is harmlessly null and the hook stays disabled
  // (isSearching gates rendering, not this call).
  const pastOwnedPersonId = data && !data.isSelf ? data.person.id : null;
  const pastOwned = useWorkItemSearch(search, pastOwnedPersonId);

  const activeView = view ? VIEWS[view] : null;

  // A quick-access view (from a Dashboard/Team stat tile) and the page's own
  // filters (search, state chips) are mutually exclusive — applying one
  // clears the other, last one wins, rather than ANDing them together into a
  // filter combo that can silently empty the list or leave a stale "Showing:
  // …" banner up after the user picks a different filter.
  function handleSearchChange(next: string) {
    setSearch(next);
    if (next.trim() !== '' && view) onViewChange?.(null);
  }

  function toggleState(s: string) {
    if (view) onViewChange?.(null);
    setSelectedStates((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  // Seeded to null (not `view`) so a mount that *already* carries a view —
  // the Dashboard→Work Items navigation — counts as a transition too, not
  // just a later change while mounted.
  const previousView = useRef<ViewId | null>(null);
  useEffect(() => {
    if (view && view !== previousView.current) {
      setSearch('');
      setSelectedStates(new Set());
    }
    previousView.current = view;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // 'recent' reshapes data.recentItems into the same stories/standalone
  // shape 'workitems' reads straight off the dashboard — see recentTree.ts.
  const recentTree = useMemo(
    () => (data && source === 'recent' ? buildRecentTree(data) : null),
    [data, source]
  );
  const sourceStories = recentTree ? recentTree.stories : data?.stories ?? [];
  const standaloneItems = useMemo<Task[]>(
    () => (recentTree ? recentTree.standalone : (data?.groups ?? []).flatMap((g) => g.unparentedItems)),
    [data, recentTree]
  );
  const sourceGroups = useMemo(() => {
    const groups = recentTree
      ? buildRecentGroups(recentTree.stories, recentTree.standalone, data?.groups ?? [])
      : (data?.groups ?? []);
    // Guards against a stale cached dashboard payload from before
    // crossSprintItems existed, where a group may lack the field entirely.
    return groups.map((g) => (g.crossSprintItems ? g : { ...g, crossSprintItems: [] }));
  }, [data, recentTree]);

  // The sprint treated as current: the manual pin when there is one, else
  // whichever sprint's date range contains today (lib/currentSprint.ts).
  const currentSprintPath = useMemo(
    () => resolveCurrentPath(sourceGroups, markedSprintPath),
    [sourceGroups, markedSprintPath]
  );

  // Sprint sections collapse the moment a search/state-filter/view is
  // applied, rather than auto-opening to show matches — you pick which
  // sprint to open by hand. Only fires on the *transition* into a filtered
  // state, not on every keystroke while already filtering, so an already
  // manually-opened sprint doesn't get yanked shut while you refine a
  // search. Deliberately fed only into IterationGroupSection's own
  // (sprint-level) collapse, never into storyCollapseSignal — a story that
  // matched via a child task should still be expanded once its sprint is
  // opened (see forceExpandIds below).
  const isFilterActive = isSearching || selectedStates.size > 0 || !!view;
  const wasFilterActive = useRef(isFilterActive);
  const [filterCollapseSignal, setFilterCollapseSignal] = useState(0);
  useEffect(() => {
    if (isFilterActive && !wasFilterActive.current) setFilterCollapseSignal((v) => v + 1);
    wasFilterActive.current = isFilterActive;
  }, [isFilterActive]);

  const stateCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of data?.visibleStates ?? []) counts[s] = 0;
    for (const s of sourceStories) {
      counts[s.state] = (counts[s.state] ?? 0) + 1;
      for (const t of s.tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
    }
    for (const t of standaloneItems) counts[t.state] = (counts[t.state] ?? 0) + 1;
    for (const s of selectedStates) if (!(s in counts)) counts[s] = 0;
    return counts;
  }, [data, sourceStories, standaloneItems, selectedStates]);

  const stateOptions = useMemo(() => {
    const known = new Set(data?.visibleStates ?? []);
    const extra = Object.keys(stateCounts).filter((s) => !known.has(s));
    const order = [...(data?.visibleStates ?? []), ...extra];
    return order.map((s) => ({ id: s, label: s, count: stateCounts[s] ?? 0 }));
  }, [data, stateCounts]);

  const allItemsCount = useMemo(
    () => sourceStories.reduce((n, s) => n + 1 + s.tasks.length, 0) + standaloneItems.length,
    [sourceStories, standaloneItems]
  );

  function toggleSelection(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function ownStateMatches(item: { state: string }): boolean {
    return selectedStates.size === 0 || selectedStates.has(item.state);
  }

  /** Search only — text match on the story itself or (indirectly) a child
   * task. State-chip matching is handled separately in `storyVisible` so a
   * state filter can't hide a story whose *children* match it (previously
   * the #1 cause of "the state chip's count doesn't match what I see": a
   * task with state S nested under a story whose own state != S vanished
   * entirely instead of showing under its parent as context). */
  function matchesFilters(story: Story): { visible: boolean; forceExpand: boolean } {
    if (isSearching) {
      const { matches, viaTask } = matchesSearch(story, q);
      return { visible: matches, forceExpand: viaTask };
    }
    return { visible: true, forceExpand: false };
  }

  /** Chip + search only — shared by standalone tasks and nested tasks. */
  function passesChipAndSearch(item: Task): boolean {
    if (selectedStates.size > 0 && !selectedStates.has(item.state)) return false;
    if (isSearching && !textMatches(item, q)) return false;
    return true;
  }

  /** A nested task's visibility inside an already-visible story: chip +
   * search, plus the active view's predicate when it's a task-unit view
   * (a story-unit view narrows which stories show, not which of their
   * tasks do — those stay as chip/search leaves them). */
  function nestedTaskVisible(task: Task): boolean {
    if (!passesChipAndSearch(task)) return false;
    if (activeView && activeView.unit === 'task') return activeView.matches(task);
    return true;
  }

  /** A standalone (unparented) task: chip + search, plus the active view.
   * A story-unit view is about stories, not standalone tasks, so it hides
   * them entirely rather than showing something the view doesn't count. */
  function standaloneTaskVisible(task: Task): boolean {
    if (!passesChipAndSearch(task)) return false;
    if (!activeView) return true;
    if (activeView.unit === 'story') return false;
    return activeView.matches(task);
  }

  /** A story is a full match if its own state/search pass. Failing its own
   * state no longer hides it outright — it survives as context when a
   * child does match, so a matching nested task is never dropped just
   * because its parent doesn't share that state. */
  function storyVisible(story: Story): boolean {
    const { visible: searchVisible } = matchesFilters(story);
    if (!searchVisible) return false;
    const hasVisibleChild = story.tasks.some(nestedTaskVisible);
    if (!ownStateMatches(story) && !hasVisibleChild) return false;
    if (!activeView) return true;
    if (activeView.unit === 'story') return ownStateMatches(story) && activeView.matches(story);
    return hasVisibleChild;
  }

  const filteredStories = useMemo(() => {
    return sourceStories.filter(storyVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceStories, selectedStates, trimmedSearch, isSearching, view]);

  const filteredStandaloneItems = useMemo(
    () => standaloneItems.filter(standaloneTaskVisible),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [standaloneItems, selectedStates, trimmedSearch, isSearching, view]
  );

  /** Stories that matched only via a child — kept force-expanded so that,
   * once you open the sprint section that contains it (see the
   * filter-collapse behavior above), the matching child is already
   * visible instead of needing a second click. While any filter is active,
   * every visible story force-expands: once a story qualifies for any
   * reason it renders its full task list (see storyVisible/renders below),
   * so a direct story-title hit should show its children immediately too,
   * not just ones that matched via a child. */
  const forceExpandIds = useMemo(() => {
    const ids = new Set<number>();
    if (isSearching) {
      for (const s of sourceStories) if (matchesFilters(s).visible) ids.add(s.id);
    }
    if (selectedStates.size > 0) {
      for (const s of sourceStories) if (!ownStateMatches(s) && storyVisible(s)) ids.add(s.id);
    }
    if (view) {
      for (const s of sourceStories) if (storyVisible(s)) ids.add(s.id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceStories, trimmedSearch, isSearching, view, selectedStates]);

  const filteredGroups = useMemo(() => {
    return orderGroups(
      sourceGroups
        .map((g) => ({
          ...g,
          stories: g.stories.filter(storyVisible),
          unparentedItems: g.unparentedItems.filter(standaloneTaskVisible),
          // Same chip/search/view predicate as unparentedItems — a promoted
          // entry is Task-shaped like they are.
          crossSprintItems: (g.crossSprintItems ?? []).filter(standaloneTaskVisible),
        }))
        // A group surviving on crossSprintItems alone (no story, no
        // unparented item of its own) is NOT empty — it still has a row to
        // show, so it must not be filtered out here.
        .filter((g) => g.stories.length > 0 || g.unparentedItems.length > 0 || g.crossSprintItems.length > 0),
      currentSprintPath
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceGroups, selectedStates, trimmedSearch, isSearching, view, currentSprintPath]);

  const combinedProgress = useMemo(() => {
    if (!data || selectedIds.size === 0) return null;
    const selectedStories = sourceStories.filter((s) => selectedIds.has(s.id));
    const selectedStandalone = standaloneItems.filter((t) => selectedIds.has(t.id));
    const totals = [...selectedStories, ...selectedStandalone].reduce(
      (acc, s) => {
        acc.estimated += s.hours.estimated;
        acc.completed += s.hours.completed;
        return acc;
      },
      { estimated: 0, completed: 0 }
    );
    const pct = totals.estimated > 0 ? Math.round((totals.completed / totals.estimated) * 100) : 0;
    return { count: selectedStories.length + selectedStandalone.length, ...totals, pct };
  }, [data, sourceStories, standaloneItems, selectedIds]);

  const viewCounts = useMemo(() => {
    if (!data || !view || !activeView) return null;
    const total = countFor(view, data);
    if (activeView.unit === 'story') {
      const visible = sourceStories.filter((s) => activeView.matches(s) && matchesFilters(s).visible).length;
      return { visible, total, unit: activeView.unit };
    }
    const allTasks = [...sourceStories.flatMap((s) => s.tasks), ...standaloneItems];
    const visible = allTasks.filter((t) => activeView.matches(t) && passesChipAndSearch(t)).length;
    return { visible, total, unit: activeView.unit };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sourceStories, standaloneItems, view, selectedStates, trimmedSearch, isSearching]);

  // Counted by DISTINCT work item id (FR-019, data-model.md §6.2) and over the same
  // population the state chips count — stories, the tasks nested under them, and
  // unparented items — so the header and the "All" chip always give one number. A
  // cross-sprint-promoted entry is the same task already nested under its story, so
  // it never adds a second count.
  const matchingItemCount = !isFilterActive
    ? allItemsCount
    : sourceStories.reduce(
        (n, s) => n + (ownStateMatches(s) && (!isSearching || textMatches(s, q)) ? 1 : 0) + s.tasks.filter(passesChipAndSearch).length,
        0
      ) + standaloneItems.filter(passesChipAndSearch).length;
  const visibleCount = viewCounts ? viewCounts.visible : matchingItemCount;
  const totalCount = viewCounts ? viewCounts.total : allItemsCount;

  let unitLabel = t('workitems.genericUnit', { count: totalCount });
  if (viewCounts) {
    unitLabel = t(viewCounts.unit === 'story' ? 'workitems.story' : 'workitems.task', { count: totalCount });
  }

  let countLabel: string;
  if (visibleCount === totalCount) {
    countLabel = `${totalCount} ${unitLabel}`;
  } else {
    countLabel = t('workitems.countDisplay', { visible: visibleCount, total: totalCount, unit: unitLabel });
  }

  if (isLoading && !data) return <LoadingView label={t('workitems.syncingLabel')} />;
  if (isError && !data) return <ErrorView message={t('workitems.couldNotLoad')} onRetry={refetch} />;
  if (!data) return null;

  return (
    <div className="space-y-4 pb-16">
      {showHeading && (
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-ink">{heading ?? t('nav.workitems')}</h1>
          <span className="text-xs text-ink-subtle tabular-nums">{countLabel}</span>
        </div>
      )}

      {view && activeView && (
        <div
          role="group"
          aria-label={t('workitems.activeViewFilterAriaLabel')}
          className="flex items-center gap-2 rounded-card border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-medium text-accent"
        >
          <span>
            {t('workitems.showing', { label: activeView.label, count: viewCounts?.total ?? 0 })}
          </span>
          <button
            type="button"
            onClick={() => onViewChange?.(null)}
            className="focus-ring ms-auto flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-accent transition-colors hover:bg-accent/15"
            aria-label={t('workitems.clearAppliedView')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <Toolbar aria-label={t('workitems.listControlsAriaLabel')} stacked>
        <ToolbarRow>
          <SearchInput value={search} onChange={handleSearchChange} placeholder={t('workitems.searchByIdOrTitle')} maxWidth={220} />
        </ToolbarRow>

        <ToolbarRow>
          <FilterChips
            options={stateOptions}
            selected={selectedStates}
            onToggle={toggleState}
            onClear={() => {
              if (view) onViewChange?.(null);
              setSelectedStates(new Set());
            }}
            allCount={allItemsCount}
          />
        </ToolbarRow>

        <ToolbarRow className="justify-end">
          <button
            type="button"
            onClick={() => setExpandSignal((v) => v + 1)}
            className="focus-ring flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
            title={t('workitems.expandAll')}
          >
            <ChevronsUpDown size={14} />
            <span>{t('workitems.expandAll')}</span>
          </button>
          <button
            type="button"
            onClick={() => setCollapseSignal((v) => v + 1)}
            className="focus-ring flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
            title={t('workitems.collapseAll')}
          >
            <ChevronsDownUp size={14} />
            <span>{t('workitems.collapseAll')}</span>
          </button>
          <Menu
            label={t('workitems.view')}
            icon={SlidersHorizontal}
            options={[
              {
                id: 'group-by-iteration',
                label: t('workitems.groupByIterationLabel'),
                description: t('workitems.groupByIterationDesc'),
                checked: groupByIteration,
                onToggle: () => setGroupByIteration((v) => !v),
              },
              {
                id: 'cumulative-progress',
                label: t('workitems.cumulativeProgress'),
                description: t('workitems.cumulativeProgressDesc'),
                checked: selectMode,
                onToggle: () => {
                  setSelectMode((v) => !v);
                  setSelectedIds(new Set());
                },
              },
            ]}
          />
        </ToolbarRow>
      </Toolbar>

      {selectMode && (
        <p className="text-xs text-ink-subtle">{t('workitems.selectHelpText')}</p>
      )}

      {groupByIteration ? (
        filteredGroups.length === 0 ? (
          <EmptyView>{t('workitems.noMatchFilter')}</EmptyView>
        ) : (
          <div className="space-y-2">
            {filteredGroups.map((group) => (
              <IterationGroupSection
                key={group.iterationPath ?? 'unscheduled'}
                group={group}
                org={data.org}
                project={data.project}
                isSelf={data.isSelf}
                persistKey={`workitems:${scope}:sprint:${group.iterationPath ?? 'unscheduled'}`}
                isCurrent={isCurrentGroup(group, currentSprintPath)}
                isPinned={markedSprintPath !== null && group.iterationPath === markedSprintPath}
                onMarkCurrent={group.iterationPath ? () => setCurrentSprint(group.iterationPath) : undefined}
                forceExpandStoryIds={forceExpandIds}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelection}
                expandSignal={expandSignal}
                collapseSignal={collapseSignal}
                autoCollapseSignal={filterCollapseSignal}
                storyExpandSignal={expandSignal}
                storyCollapseSignal={collapseSignal}
              />
            ))}
          </div>
        )
      ) : filteredStories.length === 0 && filteredStandaloneItems.length === 0 ? (
        <EmptyView>{t('workitems.noMatchFilter')}</EmptyView>
      ) : (
        <div className="space-y-2">
          {filteredStories.map((story) => (
            <StoryCard
              key={story.id}
              story={story}
              org={data.org}
              project={data.project}
              isSelf={data.isSelf}
              forceExpanded={forceExpandIds.has(story.id)}
              selectMode={selectMode}
              selected={selectedIds.has(story.id)}
              onToggleSelect={() => toggleSelection(story.id)}
              expandSignal={expandSignal}
              collapseSignal={collapseSignal}
            />
          ))}
          {filteredStandaloneItems.map((item) => (
            <TaskCard
              key={item.id}
              task={item}
              org={data.org}
              project={data.project}
              isSelf={data.isSelf}
              selectMode={selectMode}
              selected={selectedIds.has(item.id)}
              onToggleSelect={() => toggleSelection(item.id)}
            />
          ))}
        </div>
      )}

      {isSearching && (
        <PastOwnedSection
          results={pastOwned.results}
          truncated={pastOwned.truncated}
          isPending={pastOwned.isPending}
          org={data.org}
          project={data.project}
        />
      )}

      {combinedProgress && (
        <div className="fixed inset-x-4 bottom-4 z-raised mx-auto flex max-w-lg items-center justify-between gap-4 rounded-card border border-accent/30 bg-surface-raised px-4 py-3 shadow-lg sm:inset-x-auto sm:end-6">
          <div className="text-xs text-ink-muted">
            {t('workitems.itemsSelected', {
              count: combinedProgress.count,
              completed: formatHours(combinedProgress.completed),
              estimated: formatHours(combinedProgress.estimated),
            })}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold tabular-nums text-accent">{combinedProgress.pct}%</span>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="focus-ring cursor-pointer rounded text-ink-subtle transition-colors hover:text-ink"
              aria-label={t('workitems.clearSelection')}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, GitBranch } from 'lucide-react';
import { DirectionalIcon } from './ui/DirectionalIcon';
import type { Dashboard, Story } from '../lib/types';
import { StateChip } from './StateChip';
import { ProgressBar } from './ProgressBar';
import { TaskCard } from './TaskCard';
import { PRRow } from './PRRow';
import { formatDate, formatHours } from '../lib/format';
import { useLang } from '../lib/i18n/useLang';
import { useTranslation } from '../lib/i18n';
import { workItemUrl } from '../lib/adoLinks';
import { moveStoryChildrenToIteration, setWorkItemState } from '../lib/api';
import { queryKeyFor } from '../lib/useDashboard';
import { patchWorkItemIterationInDashboard, patchWorkItemStateInDashboard } from '../lib/patchTask';
import { countSprintMismatches } from '../lib/sprintMismatch';
import { StoryMismatchAction } from './StoryMismatchAction';
import { typeTheme } from '../lib/typeTheme';
import { usePersistedState } from '../lib/persistedState';
import { PR_PAGE_SIZE, takePrs } from '../lib/prPaging';
import { AccentBar } from './ui/AccentBar';
import { IconButton } from './ui/IconButton';
import { LoadMore } from './ui/LoadMore';
import { Foreign } from './ui/Foreign';

interface StoryCardProps {
  story: Story;
  org: string;
  project: string;
  isSelf?: boolean;
  forceExpanded?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Omits the expanded child-task grid — for the dashboard's "recently
   * updated" list, where every task already appears as its own top-level
   * card, so nesting them here too would show each one twice. PRs still
   * show; only the task grid is suppressed. */
  hideTasks?: boolean;
  expandSignal?: number;
  collapseSignal?: number;
}

export function StoryCard({
  story,
  org,
  project,
  isSelf = true,
  forceExpanded,
  selectMode,
  selected,
  onToggleSelect,
  hideTasks,
  expandSignal,
  collapseSignal,
}: StoryCardProps) {
  useLang((s) => s.lang); // subscribe so formatDate()/formatHours() below re-render on language switch
  const t = useTranslation();
  const [expanded, setExpanded] = usePersistedState(`story:${story.id}`, !!forceExpanded);
  const [prsOpen, setPrsOpen] = usePersistedState(`story-prs:${story.id}`, false);
  const [prLimit, setPrLimit] = useState(PR_PAGE_SIZE);
  const [stateSaving, setStateSaving] = useState(false);
  const queryClient = useQueryClient();
  // 006-linked-identity-aliases (FR-008) — see TaskCard's identical comment.
  const canEdit = isSelf && (story.editable ?? true);

  useEffect(() => {
    if (forceExpanded) setExpanded(true);
  }, [forceExpanded]);
  useEffect(() => { if (expandSignal) setExpanded(true); }, [expandSignal]);
  useEffect(() => { if (collapseSignal) setExpanded(false); }, [collapseSignal]);
  // Search/view forced-expand deliberately doesn't open the PR list too —
  // those drill-downs match against story/task titles, not PRs, so opening
  // PRs alongside them would just be noise.
  useEffect(() => { if (expandSignal) setPrsOpen(true); }, [expandSignal]);
  useEffect(() => { if (collapseSignal) setPrsOpen(false); }, [collapseSignal]);
  const pagedPrs = takePrs(story.pullRequests, prLimit);

  async function handleStateChange(newState: string) {
    setStateSaving(true);
    try {
      await setWorkItemState(story.id, newState);
      // The self dashboard (queryKeyFor(null)) is the only writable one —
      // a teammate's section on the Team page renders isSelf=false, which
      // hides this control entirely, and the server independently rejects
      // writes to items not assigned to the PAT owner.
      queryClient.setQueryData<Dashboard>(queryKeyFor(null), (prev) =>
        prev ? patchWorkItemStateInDashboard(prev, story.id, newState) : prev
      );
    } catch {
      // no inline error surface here either — see TaskCard's handleStateChange
    } finally {
      setStateSaving(false);
    }
  }

  const theme = typeTheme(story.type);
  const tasksToRender = story.tasks;
  const mismatchCount = countSprintMismatches(story);

  async function handleMoveAllToStorySprint() {
    const result = await moveStoryChildrenToIteration(story.id);
    if (result.moved.length > 0) {
      queryClient.setQueryData<Dashboard>(queryKeyFor(null), (prev) =>
        prev ? patchWorkItemIterationInDashboard(prev, result.moved, result.iterationPath) : prev
      );
    }
    return result;
  }

  return (
    <div
      className={`relative rounded-card border ${theme.tint} ${
        selected ? `${theme.border} ring-2 ring-accent ring-offset-2 ring-offset-surface` : theme.border
      }`}
      title={story.type}
    >
      <AccentBar tone={theme.accentTone} />
      {/* Plain div, not role="button" — it holds real interactive children
       * (links, the select checkbox, the StateChip dropdown trigger), and
       * a div-with-role wrapping other interactive elements is an ARIA
       * nesting violation. Expand/collapse now lives on the chevron button
       * below, which is the one truly dedicated toggle control. */}
      <div className="flex w-full flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            {selectMode && (
              <input
                type="checkbox"
                checked={!!selected}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggleSelect?.()}
                className="focus-ring mt-1 h-4 w-4 shrink-0 cursor-pointer accent-accent"
                aria-label={t('storyCard.selectAriaLabel', { id: story.id })}
              />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-ink-subtle">
                <a
                  href={workItemUrl(org, project, story.id)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="focus-ring rounded tabular-nums underline decoration-dotted transition-colors hover:text-accent"
                >
                  #{story.id}
                </a>
                {story.repository && (
                  <span className="flex items-center gap-1">
                    <GitBranch size={12} /> {story.repository}
                  </span>
                )}
              </div>
              <a
                href={workItemUrl(org, project, story.id)}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="focus-ring mt-1 flex items-start gap-1 rounded text-sm font-semibold text-ink transition-colors hover:text-accent"
              >
                {/* dir="auto" lives on the title span, not this flex
                 * container — putting it on the container would flip the
                 * order of the title and the icon for an Arabic title. */}
                <Foreign as="span" className="truncate text-start">{story.title}</Foreign>
                <ExternalLink size={12} className="mt-0.5 shrink-0 text-ink-subtle" />
              </a>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StateChip
              state={story.state}
              type={story.type}
              editable={canEdit}
              pending={stateSaving}
              onChange={handleStateChange}
            />
            <IconButton
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? t('storyCard.collapseAriaLabel') : t('storyCard.expandAriaLabel')}
              aria-expanded={expanded}
            >
              <ChevronDown size={16} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </IconButton>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <ProgressBar pct={story.completionPct} />
          <span className="w-10 shrink-0 text-end text-xs font-medium tabular-nums text-ink-muted">
            {story.completionPct}%
          </span>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted tabular-nums">
          <span>
            {t('workitems.hoursProgress', { completed: formatHours(story.hours.completed), estimated: formatHours(story.hours.estimated) })}
            <span className="text-ink-subtle"> ({story.completionBasis === 'hours' ? t('storyCard.completionByHours') : story.completionBasis === 'tasks' ? t('storyCard.completionByTasks') : t('storyCard.completionByState')})</span>
          </span>
          <span>{t('storyCard.hoursRemaining', { hours: formatHours(story.hours.remaining) })}</span>
          <span>{t('storyCard.updatedDate', { date: formatDate(story.changedDate) })}</span>
          {story.dueDate && <span>{t('storyCard.dueDate', { date: formatDate(story.dueDate) })}</span>}
          <span>{t('storyCard.taskCount', { count: story.tasks.length })}</span>
          {story.hiddenTaskCount > 0 && (
            <span className="text-ink-subtle">{t('storyCard.hiddenNotYours', { count: story.hiddenTaskCount })}</span>
          )}
          {mismatchCount > 0 && (
            <StoryMismatchAction
              mismatchCount={mismatchCount}
              targetIterationPath={story.iterationPath}
              editable={canEdit}
              onMoveAll={handleMoveAllToStorySprint}
            />
          )}
          {story.pullRequests.length > 0 && (
            <span>{t('pr.countLabel', { count: story.pullRequests.length })}</span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border p-4">
          {!hideTasks && tasksToRender.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {tasksToRender.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  org={org}
                  project={project}
                  isSelf={isSelf}
                  parentIterationPath={story.iterationPath}
                />
              ))}
            </div>
          )}
          {story.pullRequests.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setPrsOpen((v) => !v)}
                aria-expanded={prsOpen}
                className="focus-ring flex cursor-pointer items-center gap-1 text-xs font-medium text-ink-subtle transition-colors hover:text-ink"
              >
                <DirectionalIcon>
                  <ChevronRight size={16} className={`shrink-0 transition-transform ${prsOpen ? 'rotate-90' : ''}`} />
                </DirectionalIcon>
                <span>{t('storyCard.pullRequestsToggle', { count: story.pullRequests.length })}</span>
              </button>
              {prsOpen && (
                <div className="mt-2 space-y-2">
                  {pagedPrs.prs.map((pr) => (
                    <PRRow key={pr.id} pr={pr} />
                  ))}
                  {pagedPrs.shown < pagedPrs.total && (
                    <LoadMore shown={pagedPrs.shown} total={pagedPrs.total} onClick={() => setPrLimit((v) => v + PR_PAGE_SIZE)} />
                  )}
                </div>
              )}
            </div>
          )}
          {(hideTasks ? story.pullRequests.length === 0 : tasksToRender.length === 0 && story.pullRequests.length === 0) && (
            <p className="text-sm text-ink-subtle">
              {hideTasks ? t('storyCard.noPullRequestsLinked') : t('storyCard.noTasksOrPullRequestsLinked')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}


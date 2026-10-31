import type { Dashboard, Hours, RecentItem, Story, Task } from './types';

function recomputeProgress(hours: Hours, previousBasis: Task['progressBasis']): { progressPct: number; progressBasis: Task['progressBasis'] } {
  if (hours.estimated > 0 && hours.completed > 0) {
    return { progressPct: Math.min(100, Math.round((hours.completed / hours.estimated) * 100)), progressBasis: 'hours' };
  }
  return { progressPct: 0, progressBasis: previousBasis };
}

/**
 * Applies `patchStory`/`patchTasks` across every place the dashboard payload
 * serializes the same work item as an independent JSON copy: `stories`,
 * `groups[].stories[].tasks`, `groups[].unparentedItems`, and `recentItems`
 * (both its `story` and standalone `task` shapes). Missing this last one is
 * what let an optimistic write appear to do nothing on the Dashboard page,
 * which renders `recentItems` exclusively — see DashboardPage.tsx.
 */
function patchDashboard(dashboard: Dashboard, patchStory: (s: Story) => Story, patchTasks: (t: Task[]) => Task[]): Dashboard {
  function patchStoryWithTasks(story: Story): Story {
    return patchStory({ ...story, tasks: patchTasks(story.tasks) });
  }

  function patchRecentItem(entry: RecentItem): RecentItem {
    if (entry.kind === 'story') return { ...entry, story: patchStoryWithTasks(entry.story) };
    const [task] = patchTasks([entry.task]);
    return { ...entry, task };
  }

  return {
    ...dashboard,
    stories: dashboard.stories.map(patchStoryWithTasks),
    groups: dashboard.groups.map((g) => ({
      ...g,
      stories: g.stories.map(patchStoryWithTasks),
      unparentedItems: patchTasks(g.unparentedItems),
      // A cross-sprint-promoted card (005-search-history-sprint-placement)
      // is the SAME task as the one nested under its story two lines above —
      // both copies must move together, or an optimistic write on one would
      // leave the other showing stale hours/state until the next sync.
      crossSprintItems: patchTasks(g.crossSprintItems),
    })),
    recentItems: dashboard.recentItems.map(patchRecentItem),
  };
}

/**
 * Applies a just-written task's new hours (and, if it auto-closed, its new
 * state) directly into the cached dashboard payload for instant feedback,
 * without waiting for the background resync. Story-level rollups
 * (completionPct, hour totals) are intentionally left as-is here —
 * recomputing them client-side would duplicate the multi-basis logic that
 * lives in server/compute/rollup.js — they catch up when the SSE-triggered
 * refetch lands a few seconds later.
 */
export function patchTaskInDashboard(dashboard: Dashboard, taskId: number, hours: Hours, newState?: string): Dashboard {
  function patchTask(task: Task): Task {
    if (task.id !== taskId) return task;
    return { ...task, hours, state: newState ?? task.state, ...recomputeProgress(hours, task.progressBasis) };
  }

  return patchDashboard(
    dashboard,
    (story) => story,
    (tasks) => tasks.map(patchTask)
  );
}

/**
 * Applies a standalone state change (the manual picker) into the cached
 * payload for instant feedback. `id` may be a story, task, or unparented
 * item — whichever it is, only its `state` field changes; hours and
 * rollups are left alone the same way patchTaskInDashboard leaves them,
 * catching up on the next sync.
 */
export function patchWorkItemStateInDashboard(dashboard: Dashboard, id: number, newState: string): Dashboard {
  return patchDashboard(
    dashboard,
    (story) => (story.id === id ? { ...story, state: newState } : story),
    (tasks) => tasks.map((t) => (t.id === id ? { ...t, state: newState } : t))
  );
}

/**
 * Applies just-written "move to sprint" iteration changes into the cached
 * payload — `ids` are always nested Task/Bug ids (see sprintMismatch.ts),
 * covering both the single-task move and the story-level bulk move.
 */
export function patchWorkItemIterationInDashboard(dashboard: Dashboard, ids: number[], iterationPath: string | null): Dashboard {
  const idSet = new Set(ids);
  return patchDashboard(
    dashboard,
    (story) => story,
    (tasks) => tasks.map((t) => (idSet.has(t.id) ? { ...t, iterationPath } : t))
  );
}

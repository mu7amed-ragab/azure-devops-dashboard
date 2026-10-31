import type { Dashboard, Story, Task } from './types';

export type ViewId = 'active-stories' | 'blocked-stories' | 'tasks-in-progress' | 'blocked';

interface ViewDef {
  label: string;
  unit: 'story' | 'task';
  matches(item: Story | Task): boolean;
}

const ACTIVE_CATEGORIES = new Set(['Proposed', 'InProgress']);

// tasks-in-progress deliberately overlaps the Blocked tile: a blocked task
// is still InProgress-category work, and dropping it here was the original
// "vanishing task" bug this view exists to fix. Documented on the tile via
// StatTile's `title`, not filtered out here.
//
// Its "Tasks" label is kept on purpose (007-all-assigned-types, spec FR-007,
// research.md R14): like tasksIn() below, the count covers InProgress items of
// EVERY assigned work item type — a Feature or a custom type sitting
// unparented counts here too — not only items whose type is Task.
export const VIEWS: Record<ViewId, ViewDef> = {
  'active-stories': {
    label: 'Active stories',
    unit: 'story',
    matches: (item) => ACTIVE_CATEGORIES.has(item.stateCategory ?? ''),
  },
  'blocked-stories': {
    label: 'Blocked stories',
    unit: 'story',
    matches: (item) => 'blocked' in item && item.blocked === true,
  },
  'tasks-in-progress': {
    label: 'Tasks in progress',
    unit: 'task',
    matches: (item) => item.stateCategory === 'InProgress',
  },
  blocked: {
    label: 'Blocked tasks',
    unit: 'task',
    matches: (item) => 'blocked' in item && item.blocked === true,
  },
};

export function storiesIn(data: Dashboard): Story[] {
  return data.stories;
}

/** Every task the app knows about for this person: nested inside a story,
 * or unparented — the exact two arrays WorkItemsView renders. */
export function tasksIn(data: Dashboard): Task[] {
  return [...data.stories.flatMap((s) => s.tasks), ...data.groups.flatMap((g) => g.unparentedItems)];
}

export function countFor(view: ViewId, data: Dashboard): number {
  const def = VIEWS[view];
  const items = def.unit === 'story' ? storiesIn(data) : tasksIn(data);
  return items.filter((item) => def.matches(item)).length;
}

import type { Dashboard, IterationGroup, Story, Task } from './types';
import { sprintLabel } from './sprintMismatch';

/** Reshapes the Dashboard's flat `recentItems` list into the same
 * story→tasks / standalone-items shape the Work Items page already renders,
 * so both surfaces can share one list engine (WorkItemsView).
 *
 * A recent story keeps its full `tasks` array (all of that story's current
 * children, not just the ones that were themselves recently touched) — the
 * same "expand to see its tasks" relationship the Work Items page shows. A
 * recent task whose parent story isn't itself in the recent set is still
 * attached to that parent (looked up from the full `data.stories` pool) so
 * the story→task relationship never disappears — that parent renders as
 * context even though it wasn't "recently updated" on its own. A task with
 * no resolvable parent is standalone. */
export function buildRecentTree(data: Dashboard): { stories: Story[]; standalone: Task[] } {
  const allStoriesById = new Map(data.stories.map((s) => [s.id, s]));
  const usedStoryIds = new Set<number>();
  const stories: Story[] = [];
  const standalone: Task[] = [];

  for (const entry of data.recentItems) {
    if (entry.kind === 'story') {
      if (!usedStoryIds.has(entry.story.id)) {
        stories.push(entry.story);
        usedStoryIds.add(entry.story.id);
      }
      continue;
    }
    const task = entry.task;
    const parentId = task.parentId;
    if (parentId != null) {
      if (usedStoryIds.has(parentId)) continue; // already included via its story
      const parentStory = allStoriesById.get(parentId);
      if (parentStory) {
        stories.push(parentStory);
        usedStoryIds.add(parentId);
        continue;
      }
    }
    standalone.push(task);
  }
  return { stories, standalone };
}

function changedAt(iso: string | null): number {
  return iso ? new Date(iso).getTime() : 0;
}

/** Buckets recent-derived stories/standalone items by iteration path,
 * borrowing sprint metadata (dates, isLatest) from the full dashboard's
 * `groups` when available, sorted by most recent activity in the bucket —
 * "recently updated" has no natural sprint order of its own. */
export function buildRecentGroups(stories: Story[], standalone: Task[], fullGroups: IterationGroup[]): IterationGroup[] {
  const metaByPath = new Map(fullGroups.filter((g) => g.iterationPath).map((g) => [g.iterationPath as string, g]));
  const buckets = new Map<string | null, { stories: Story[]; unparentedItems: Task[] }>();

  function bucketFor(path: string | null) {
    const key = path ?? null;
    if (!buckets.has(key)) buckets.set(key, { stories: [], unparentedItems: [] });
    return buckets.get(key)!;
  }

  for (const s of stories) bucketFor(s.iterationPath).stories.push(s);
  for (const t of standalone) bucketFor(t.iterationPath).unparentedItems.push(t);

  const withActivity = [...buckets.entries()].map(([path, bucket]) => {
    const meta = path ? metaByPath.get(path) : undefined;
    const activity = Math.max(
      0,
      ...bucket.stories.map((s) => changedAt(s.changedDate)),
      ...bucket.unparentedItems.map((t) => changedAt(t.changedDate))
    );
    const hours = [...bucket.stories, ...bucket.unparentedItems].reduce(
      (acc, item) => {
        acc.estimated += item.hours.estimated;
        acc.completed += item.hours.completed;
        acc.remaining += item.hours.remaining;
        return acc;
      },
      { estimated: 0, completed: 0, remaining: 0 }
    );
    const group: IterationGroup = {
      iterationPath: path,
      iterationName: meta ? meta.iterationName : sprintLabel(path),
      startDate: meta ? meta.startDate : null,
      finishDate: meta ? meta.finishDate : null,
      isLatest: meta ? meta.isLatest : false,
      hours,
      stories: bucket.stories,
      unparentedItems: bucket.unparentedItems,
      // "Recently updated" is a flat, ungrouped list by construction
      // (queryRecentlyUpdated) — cross-sprint promotion is a sprint-grouping
      // concept this synthetic regrouping doesn't participate in.
      crossSprintItems: [],
    };
    return { group, activity };
  });

  return withActivity.sort((a, b) => b.activity - a.activity).map((entry) => entry.group);
}

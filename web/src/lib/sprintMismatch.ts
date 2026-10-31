import type { Story } from './types';
import { t } from './i18n';

/** Leaf segment of a backslash-delimited IterationPath, e.g.
 * "ProjectA\Sprint 78" -> "Sprint 78". */
export function sprintLabel(path: string | null): string {
  if (!path) return t('workitems.noSprint');
  const parts = path.split('\\');
  return parts[parts.length - 1] || path;
}

/** True when a nested task's own sprint differs from its parent story's —
 * the case where a story moved iterations but its children were left
 * behind (Azure DevOps doesn't cascade IterationPath down the hierarchy).
 * Silent when either side is empty — nothing to compare a task with no
 * sprint against. */
export function isSprintMismatch(taskIterationPath: string | null, storyIterationPath: string | null): boolean {
  if (!taskIterationPath || !storyIterationPath) return false;
  return taskIterationPath !== storyIterationPath;
}

/** How many of a story's tasks are on a different sprint than the story. */
export function countSprintMismatches(story: Story): number {
  return story.tasks.filter((t) => isSprintMismatch(t.iterationPath, story.iterationPath)).length;
}

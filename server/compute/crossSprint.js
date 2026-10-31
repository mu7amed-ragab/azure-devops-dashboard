/**
 * Cross-sprint child promotion (005-search-history-sprint-placement, US2).
 *
 * A task whose own IterationPath differs from its parent story's is already
 * visible NESTED under that story, badged by SprintMismatchChip (US3,
 * already shipped) — but it is invisible in ITS OWN sprint's section, which
 * is exactly what this feature exists to fix. This module computes the
 * "promoted" standalone entries; server/sync.js's groupByIteration decides
 * which sprint bucket (existing or newly created) each one lands in and
 * appends them AFTER that bucket's `hours` total is computed — see the
 * comment there for why the ordering is load-bearing.
 *
 * Pure and side-effect free: no ADO call, no state/type name branched on,
 * only iteration paths compared. `isRecentEnoughIteration` is passed in
 * rather than reimplemented here so MIN_ITERATION_YEAR stays defined in
 * exactly one place (server/sync.js).
 */

/**
 * True when `task` should be promoted into its own sprint's section, away
 * from `story` (data-model.md §3):
 *
 *   task.iterationPath !== null                 — nothing to place it by
 *   story.iterationPath !== null                 — nothing to compare against (FR-020)
 *   task.iterationPath !== story.iterationPath   — same sprint, nothing to promote (FR-012/017)
 *   the task's own path resolves to a real, dated sprint at MIN_ITERATION_YEAR+
 *
 * An unresolvable path (e.g. "UDC", outside this project's iteration tree)
 * or one before MIN_ITERATION_YEAR must NOT create a "No sprint" promotion —
 * the task is already visible nested under its story, and promoting it into
 * the unscheduled bucket would be a duplicate with no informational value.
 */
function shouldPromote(task, story, isPromotableIteration) {
  if (!task.iterationPath) return false;
  if (!story.iterationPath) return false;
  if (task.iterationPath === story.iterationPath) return false;
  return isPromotableIteration(task.iterationPath);
}

/**
 * @param {Array} stories visible stories (already state/recency-filtered —
 *   the same array passed to groupByIteration), each carrying `tasks`
 *   (already filtered to this person's own — see _runSyncPass)
 * @param {(iterationPath: string) => boolean} isPromotableIteration true
 *   only when the path resolves to a real, dated sprint (iterationMap has an
 *   entry with a startDate) AND that sprint is MIN_ITERATION_YEAR or later —
 *   both halves of data-model.md §3's last two predicate clauses, combined
 *   by the caller (server/sync.js) into one function so this module never
 *   needs iterationMap or MIN_ITERATION_YEAR directly.
 * @returns {Array<{iterationPath: string, item: object}>} one entry per
 *   promoted task, each `item` a clone of the nested Task carrying a
 *   `parentRef` built from its already-hydrated parent story — no extra ADO
 *   call. The SAME task also stays nested under its story, unchanged, with
 *   `parentRef: null` there (invariant §6.1) — this function only ever
 *   reads `stories`, never mutates a task in place.
 */
function computeCrossSprintPromotions(stories, isPromotableIteration) {
  const promotions = [];
  for (const story of stories) {
    for (const task of story.tasks) {
      if (!shouldPromote(task, story, isPromotableIteration)) continue;
      promotions.push({
        iterationPath: task.iterationPath,
        item: {
          ...task,
          parentRef: {
            id: story.id,
            title: story.title,
            type: story.type,
            iterationPath: story.iterationPath,
          },
        },
      });
    }
  }
  return promotions;
}

module.exports = { shouldPromote, computeCrossSprintPromotions };

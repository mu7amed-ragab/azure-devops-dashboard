/**
 * US2: per-story sprint progress (FR-015 through FR-019, FR-005). Pure
 * function over the sprint's SprintItem list (server/ado/sprintItems.js) and
 * the revision index's hours history — nothing here calls Azure DevOps.
 *
 * See data-model.md §4.
 */

const { STAGE_PROGRESS_BY_CATEGORY } = require('../scrumConstants');

/**
 * @param {Array} storyItems SprintItem records for this sprint's story-level
 *   items only (data-model.md §2a) — title/assignee/url/state come from here.
 * @param {Map<number, number[]>} childrenMap parentId -> childId[]
 * @param {object} sync SyncEngine — used only for getFieldAt('completedWork'|
 *   'remainingWork', id, asOfDate); a story's progress is always measured "as
 *   of now" (today), not at some sprint boundary.
 * @param {string} asOfDate ISO date to read hours as-of (normally today).
 * @returns {{stories: Array, counts: {completed:number,inProgress:number,notStarted:number}}}
 */
function computeSprintProgress(storyItems, childrenMap, sync, asOfDate) {
  const stories = [];
  let completed = 0;
  let inProgress = 0;
  let notStarted = 0;

  for (const item of storyItems) {
    // FR-017: a Removed-category item is excluded from the list entirely
    // rather than given a progress value.
    if (item.stateCategory === 'Removed') continue;

    const childIds = childrenMap.get(item.id) || [];
    const itemIds = [item.id, ...childIds];
    let completedSum = 0;
    let remainingSum = 0;
    let sawAny = false;
    for (const id of itemIds) {
      const c = sync.getFieldAt(id, 'completedWork', asOfDate);
      const r = sync.getFieldAt(id, 'remainingWork', asOfDate);
      if (c != null || r != null) sawAny = true;
      completedSum += c || 0;
      remainingSum += r || 0;
    }

    const denominator = completedSum + remainingSum;
    let progress;
    let progressBasis;
    // FR-016a: denominator zero or absent (no measurable hours anywhere on
    // the story or its descendants) falls back to the stage-derived value.
    if (sawAny && denominator > 0) {
      progress = completedSum / denominator;
      progressBasis = 'hours';
    } else {
      progress = STAGE_PROGRESS_BY_CATEGORY[item.stateCategory] ?? 0;
      progressBasis = 'stage';
    }

    stories.push({
      id: item.id,
      title: item.title,
      type: item.type,
      state: item.state,
      stateCategory: item.stateCategory,
      assignedTo: item.assignedTo,
      progress,
      progressBasis,
      url: item.url,
    });

    // FR-018a: Proposed -> notStarted; InProgress AND Resolved -> inProgress;
    // Completed -> completed. A Resolved story is "in progress" here even
    // though FR-017 scores its progress at 0.9 — the two answer different
    // questions (workflow stage vs. measured/inferred completion), which is
    // not a contradiction.
    if (item.stateCategory === 'Completed') completed += 1;
    else if (item.stateCategory === 'InProgress' || item.stateCategory === 'Resolved') inProgress += 1;
    else notStarted += 1;
  }

  return { stories, counts: { completed, inProgress, notStarted } };
}

module.exports = { computeSprintProgress };

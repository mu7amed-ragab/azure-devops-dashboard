// Fallback "done" list, used only when a state can't be classified by
// category (unknown type, or a state name ADO didn't return for it) —
// mirrors the "never hide/never miscount what we can't classify" posture
// used elsewhere in this file. 'Deployed To Production' is this project's
// real terminal state alongside the standard Closed/Resolved.
const CLOSED_STATES = new Set(['Closed', 'Resolved', 'Deployed To Production']);

// A work item is hidden only if its own type's ADO workflow puts its state
// in one of these categories — not by a hardcoded state-name list. Each
// work item type (User Story, Task, Bug) has its own state set in this
// project, and a hardcoded name list silently drops entire types whose
// workflow uses different names for the same lifecycle stage (e.g. Bug's
// 'Resolved'/'Ready For Testing' vs Story's 'Ready For Test (Demo)').
const HIDDEN_STATE_CATEGORIES = new Set(['Completed', 'Removed']);

/** True unless this type's workflow puts the state in a terminal category.
 * An unknown type or an unlisted state is treated as visible — never hide
 * something just because we can't classify it. `statesByType` is the
 * payload from server/ado/states.js: { [type]: [{ name, category, color }] }. */
function isVisibleState(type, state, statesByType) {
  const list = statesByType && statesByType[type];
  if (!list) return true;
  const meta = list.find((s) => s.name === state);
  if (!meta) return true;
  return !HIDDEN_STATE_CATEGORIES.has(meta.category);
}

/** The ADO category (Proposed/InProgress/Resolved/Completed/Removed) for a
 * given type+state, or null when the type/state is unknown to `statesByType`.
 * Category must be resolved per item — the same state name (e.g. 'Resolved')
 * can land in a different category on different work item types. */
function stateCategoryOf(type, state, statesByType) {
  const list = statesByType && statesByType[type];
  if (!list) return null;
  const meta = list.find((s) => s.name === state);
  return meta ? meta.category : null;
}

/** "Done" is a category, not a state name: Resolved (testing/review stages
 * that follow active work) and Completed (the terminal category) both count. */
function isDoneCategory(category) {
  return category === 'Resolved' || category === 'Completed';
}

const CATEGORY_ORDER = ['Proposed', 'InProgress', 'Resolved'];

/** Union of every visible state name across all known types, ordered
 * Proposed → InProgress → Resolved so the client's filter chips read in
 * workflow order. Feeds `dashboard.visibleStates`. */
function visibleStateNames(statesByType) {
  const seen = new Set();
  const byCategory = { Proposed: [], InProgress: [], Resolved: [], other: [] };
  for (const list of Object.values(statesByType || {})) {
    for (const s of list) {
      if (HIDDEN_STATE_CATEGORIES.has(s.category) || seen.has(s.name)) continue;
      seen.add(s.name);
      (byCategory[s.category] || byCategory.other).push(s.name);
    }
  }
  return [...CATEGORY_ORDER.flatMap((c) => byCategory[c]), ...byCategory.other];
}

// Below this fraction of tasks having any CompletedWork logged, hours-based
// completion is too sparse to trust — fall back to task-state progress
// instead of showing a misleadingly low percentage.
const MIN_HOURS_COVERAGE = 0.3;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** The work item's parent id, or null. Prefers the System.Parent field
 * (present because hydrate fetches the full field set) and falls back to the
 * Hierarchy-Reverse relation, since older items don't always carry the field. */
function parentIdOf(raw) {
  const direct = raw.fields && raw.fields['System.Parent'];
  if (Number.isFinite(Number(direct))) return Number(direct);
  const rel = (raw.relations || []).find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
  if (!rel || !rel.url) return null;
  const id = Number(rel.url.split('/').pop());
  return Number.isFinite(id) ? id : null;
}

function isBlocked(task, blockedSignal) {
  if (!blockedSignal) return false;
  const fields = task.fields || {};
  if (blockedSignal.kind === 'state') {
    const state = fields['System.State'];
    return typeof state === 'string' && state.toLowerCase() === blockedSignal.value.toLowerCase();
  }
  if (blockedSignal.kind === 'field') {
    return fields['Microsoft.VSTS.CMMI.Blocked'] === blockedSignal.value;
  }
  if (blockedSignal.kind === 'tag') {
    const tags = (fields['System.Tags'] || '').split(';').map((t) => t.trim().toLowerCase());
    return tags.includes('blocked');
  }
  return false;
}

/** Normalize a raw task work item + compute its own progress. */
function normalizeTask(raw, blockedSignal, statesByType) {
  const f = raw.fields || {};
  const estimated = num(f['Microsoft.VSTS.Scheduling.OriginalEstimate']);
  const completed = num(f['Microsoft.VSTS.Scheduling.CompletedWork']);
  const remaining = num(f['Microsoft.VSTS.Scheduling.RemainingWork']);
  const blocked = isBlocked(raw, blockedSignal);
  const rawState = f['System.State'] || 'New';
  const type = f['System.WorkItemType'] || 'Unknown';
  const stateCategory = stateCategoryOf(type, rawState, statesByType);
  const doneByState = stateCategory != null ? isDoneCategory(stateCategory) : CLOSED_STATES.has(rawState);

  // CompletedWork is frequently left unfilled in this project even on
  // finished tasks — trusting hours alone would show a "done" task at 0%.
  let progressPct;
  let progressBasis;
  if (estimated > 0 && completed > 0) {
    progressPct = Math.min(100, Math.round((completed / estimated) * 100));
    progressBasis = 'hours';
  } else {
    progressPct = doneByState ? 100 : 0;
    progressBasis = 'state';
  }

  return {
    id: raw.id,
    type,
    title: f['System.Title'] || '',
    description: f['System.Description'] || '',
    state: rawState,
    stateCategory,
    blocked,
    createdDate: f['System.CreatedDate'] || null,
    changedDate: f['System.ChangedDate'] || null,
    dueDate: f['Microsoft.VSTS.Scheduling.DueDate'] || null,
    iterationPath: f['System.IterationPath'] || null,
    assignedTo: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : null,
    assignedToId: f['System.AssignedTo'] ? f['System.AssignedTo'].id : null,
    // Needed alongside assignedToId: a teammate resolved through the
    // IdentityPicker fallback (see sync.js isPerson) can carry an originId
    // that never matches the localId ADO stamps here — uniqueName is the
    // fallback match key.
    assignedToUniqueName: f['System.AssignedTo'] ? f['System.AssignedTo'].uniqueName || null : null,
    hours: { estimated, completed, remaining },
    progressPct,
    progressBasis,
    parentId: parentIdOf(raw),
    // Populated only by a cross-sprint promotion (server/compute/crossSprint.js)
    // or a past-owned search result with a parent — normalizeTask itself never
    // knows about either, so it always starts null. See data-model.md §2.
    parentRef: null,
  };
}

/** Roll a story's tasks up into estimated/completed/remaining hours and completion %. */
function rollupStory(raw, tasks, repository, statesByType, blockedSignal) {
  const f = raw.fields || {};
  const type = f['System.WorkItemType'] || 'User Story';
  const state = f['System.State'] || 'New';
  const stateCategory = stateCategoryOf(type, state, statesByType);
  const blocked = isBlocked(raw, blockedSignal);
  const totals = tasks.reduce(
    (acc, t) => {
      acc.estimated += t.hours.estimated;
      acc.completed += t.hours.completed;
      acc.remaining += t.hours.remaining;
      return acc;
    },
    { estimated: 0, completed: 0, remaining: 0 }
  );

  let completionPct;
  let completionBasis;
  if (tasks.length === 0) {
    completionPct = (stateCategory != null ? isDoneCategory(stateCategory) : CLOSED_STATES.has(state)) ? 100 : 0;
    completionBasis = 'state';
  } else {
    const tasksWithLoggedHours = tasks.filter((t) => t.hours.completed > 0).length;
    const hoursDataSufficient = totals.estimated > 0 && tasksWithLoggedHours / tasks.length >= MIN_HOURS_COVERAGE;
    if (hoursDataSufficient) {
      completionPct = Math.min(100, Math.round((totals.completed / totals.estimated) * 100));
      completionBasis = 'hours';
    } else {
      const closed = tasks.filter((t) => (t.stateCategory != null ? isDoneCategory(t.stateCategory) : CLOSED_STATES.has(t.state))).length;
      completionPct = Math.round((closed / tasks.length) * 100);
      completionBasis = 'tasks';
    }
  }

  return {
    id: raw.id,
    title: f['System.Title'] || '',
    type,
    state,
    stateCategory,
    blocked,
    createdDate: f['System.CreatedDate'] || null,
    changedDate: f['System.ChangedDate'] || null,
    dueDate: f['Microsoft.VSTS.Scheduling.DueDate'] || null,
    iterationPath: f['System.IterationPath'] || null,
    repository: repository || null,
    hours: totals,
    completionPct,
    completionBasis,
    tasks,
    parentId: parentIdOf(raw),
    // 006-linked-identity-aliases: a story is itself a directly-assignable
    // work item (not only a container for tasks — see docs/invariants.md,
    // "My work is every type assigned to me": a childless story), so it carries the
    // same assignee pair normalizeTask already does, for `editable` gating
    // in server/sync.js's `_runSyncPass` (isPrimary) to read.
    assignedTo: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : null,
    assignedToId: f['System.AssignedTo'] ? f['System.AssignedTo'].id : null,
    assignedToUniqueName: f['System.AssignedTo'] ? f['System.AssignedTo'].uniqueName : null,
  };
}

module.exports = {
  normalizeTask,
  rollupStory,
  isBlocked,
  CLOSED_STATES,
  isVisibleState,
  visibleStateNames,
  stateCategoryOf,
  isDoneCategory,
};

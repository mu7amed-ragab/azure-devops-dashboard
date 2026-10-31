const { mapWithConcurrency } = require('../util/concurrency');
const { resolveWorkflow } = require('../compute/workflow');
const { typeTracksHours } = require('./workItemTypes');

const COMPLETED_WORK_PATH = '/fields/Microsoft.VSTS.Scheduling.CompletedWork';
const REMAINING_WORK_PATH = '/fields/Microsoft.VSTS.Scheduling.RemainingWork';
const STATE_PATH = '/fields/System.State';
const ITERATION_PATH = '/fields/System.IterationPath';
const CHILD_BATCH_SIZE = 200;
// Deliberately low — this is on top of AdoClient's own global semaphore
// (ADO_MAX_CONCURRENCY), but keeping a single bulk action from claiming most
// of that shared budget leaves headroom for whatever else is syncing.
const CHILD_MOVE_CONCURRENCY = 4;
const TASK_HOURS_FIELDS = [
  'Microsoft.VSTS.Scheduling.CompletedWork',
  'Microsoft.VSTS.Scheduling.RemainingWork',
  'Microsoft.VSTS.Scheduling.OriginalEstimate',
  'System.State',
  // Needed to resolve this item's own workflow — the automatic transitions
  // below are per-type, and a Task's Completed state is not necessarily a
  // Bug's (see server/compute/workflow.js).
  'System.WorkItemType',
  'System.AssignedTo',
].join(',');

// No state name is hardcoded anywhere in this file. Every automatic
// transition below resolves its target from the states the CURRENT project
// returned for the CURRENT work item type, by ADO category — see
// server/compute/workflow.js for why, and server/ado/states.js for where the
// list comes from. A project whose process has no Completed-category state
// for a type simply gets no auto-close, rather than a PATCH that Azure
// DevOps would reject.

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'VALIDATION';
  }
}

/** The resolved caller is themselves, but the work item they're targeting
 * isn't theirs. Distinct from ValidationError (400 — bad input) because
 * this is a 403: the request is well-formed, it's just not allowed. */
class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.code = 'FORBIDDEN';
    this.status = 403;
  }
}

/** The route-level guard already checks `person.isSelf`, but that only
 * proves the caller resolved to themselves — every write endpoint always
 * resolves to self by construction (writes are self-only), so without this
 * check any work item id would be writable regardless of who it's actually
 * assigned to. This is the check that ties the write to the specific item. */
function assertAssignedTo(current, expectedAssigneeId) {
  if (!expectedAssigneeId) return;
  if (current.assignedToId !== expectedAssigneeId) {
    throw new ForbiddenError('You can only edit work items assigned to you.');
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Always re-reads from Azure DevOps right before a write — the dashboard's
 * cached payload can be up to SYNC_INTERVAL_MS stale, and an edit must be
 * applied on top of the real current value, not a stale one. `rev` is what
 * makes the following PATCH safe against a concurrent edit elsewhere. */
async function fetchCurrentTaskHours(client, id) {
  const item = await client.get(`/wit/workitems/${id}`, { query: { fields: TASK_HOURS_FIELDS } });
  const f = item.fields || {};
  return {
    rev: item.rev,
    state: f['System.State'] || null,
    type: f['System.WorkItemType'] || null,
    estimated: num(f['Microsoft.VSTS.Scheduling.OriginalEstimate']),
    completed: num(f['Microsoft.VSTS.Scheduling.CompletedWork']),
    remaining: num(f['Microsoft.VSTS.Scheduling.RemainingWork']),
    assignedToId: f['System.AssignedTo'] ? f['System.AssignedTo'].id : null,
  };
}

/** The state (an object from this project's own list, or null) this write
 * should move the task to once its logged hours reach its estimate: the
 * Completed-category state of the task's OWN type in the CURRENT project.
 *
 * Returns null — meaning "change nothing" — whenever the transition can't be
 * justified: no estimate to reach, hours not there yet, the item is already
 * past active work (Resolved/Completed/Removed category), or this project's
 * process offers no Completed state for the type. The last case is why this
 * returns the state rather than a boolean: an unknown or Completed-less
 * workflow must produce no state patch at all, never a guessed name. */
function resolveAutoClose(current, newCompleted, workflow) {
  if (!(current.estimated > 0)) return null;
  if (newCompleted < current.estimated) return null;
  if (!workflow.known) return null;
  if (workflow.doneNames.has(current.state)) return null;
  return workflow.completedState;
}

/** The state this write should move the task to when work has just started on
 * something untouched: the InProgress-category state of its own type, but only
 * while the item still sits in its type's INITIAL state (see `initialState` in
 * server/compute/workflow.js — deliberately not "any Proposed state", because a
 * real workflow here has OnHold in that category) and this write logs the first
 * real hours. Null when the same write is already closing it out (auto-close
 * wins), or when the project's process offers no InProgress state. */
function resolveAutoActivate(current, newCompleted, workflow, willClose) {
  if (willClose) return null;
  if (!(newCompleted > 0)) return null;
  if (!workflow.known) return null;
  if (!workflow.initialState || current.state !== workflow.initialState.name) return null;
  return workflow.inProgressState;
}

/** Resolves the id of a work item's direct parent (Hierarchy-Reverse), or
 * null if it has none. Shared by the auto-activate cascade and the
 * move-to-parent-sprint write. */
async function resolveParentId(client, id) {
  const item = await client.get(`/wit/workitems/${id}`, { query: { $expand: 'relations' } });
  const parentRel = (item.relations || []).find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
  if (!parentRel) return null;
  const match = /\/workItems\/(\d+)$/i.exec(parentRel.url || '');
  return match ? Number(match[1]) : null;
}

/** Resolves the ids of a work item's direct children (Hierarchy-Forward) —
 * the mirror of resolveParentId. Used by the story-level bulk move. */
async function resolveChildIds(client, id) {
  const item = await client.get(`/wit/workitems/${id}`, { query: { $expand: 'relations' } });
  const childRels = (item.relations || []).filter((r) => r.rel === 'System.LinkTypes.Hierarchy-Forward');
  return childRels
    .map((r) => {
      const match = /\/workItems\/(\d+)$/i.exec(r.url || '');
      return match ? Number(match[1]) : null;
    })
    .filter((id) => id != null);
}

/** Batch-fetches {rev, iterationPath, assignedToId} for a set of work item
 * ids in one round trip (chunked) — used by the story-level bulk move to
 * avoid a per-child GET before each PATCH. */
async function fetchIterationBatch(client, ids) {
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHILD_BATCH_SIZE) chunks.push(ids.slice(i, i + CHILD_BATCH_SIZE));
  await Promise.all(
    chunks.map(async (idsChunk) => {
      const res = await client.post('/wit/workitemsbatch', {
        ids: idsChunk,
        fields: ['System.IterationPath', 'System.AssignedTo'],
      });
      for (const wi of res.value || []) {
        const f = wi.fields || {};
        map.set(wi.id, {
          id: wi.id,
          rev: wi.rev,
          iterationPath: f['System.IterationPath'] || null,
          assignedToId: f['System.AssignedTo'] ? f['System.AssignedTo'].id : null,
        });
      }
    })
  );
  return map;
}

/**
 * Moves every one of a story's children (tasks/bugs) that are (a) assigned
 * to the caller and (b) not already on the story's sprint, onto the story's
 * current iteration — the bulk equivalent of applyMoveToParentIteration.
 * The target path is resolved once, from the story itself, and reused for
 * every child, rather than each child re-resolving its own parent.
 *
 * A failure moving one child must not abort the rest — they're independent
 * writes to independent items, and a teammate whose token is momentarily
 * stale on one item shouldn't lose the other nine. Failures are collected
 * and returned instead of thrown, except for the up-front validation
 * (no such story / no sprint set / no children at all), which fails the
 * whole call before any write is attempted.
 */
async function applyMoveChildrenToStoryIteration(client, storyId, expectedAssigneeId) {
  const story = await fetchCurrentIteration(client, storyId);
  if (!story.iterationPath) {
    throw new ValidationError("This story has no sprint set, so there's nothing to move its tasks to.");
  }

  const childIds = await resolveChildIds(client, storyId);
  if (childIds.length === 0) {
    throw new ValidationError('This story has no linked tasks or bugs to move.');
  }

  const children = await fetchIterationBatch(client, childIds);

  const eligible = [...children.values()].filter(
    (c) => c.assignedToId === expectedAssigneeId && c.iterationPath !== story.iterationPath
  );
  const skipped = childIds.length - eligible.length;

  const moved = [];
  const failed = [];
  await mapWithConcurrency(eligible, CHILD_MOVE_CONCURRENCY, async (child) => {
    try {
      await client.patch(`/wit/workitems/${child.id}`, [
        { op: 'test', path: '/rev', value: child.rev },
        { op: 'add', path: ITERATION_PATH, value: story.iterationPath },
      ]);
      moved.push(child.id);
    } catch (err) {
      failed.push({ id: child.id, message: err.message || 'Failed to move this item.' });
    }
  });

  return { storyId, iterationPath: story.iterationPath, moved, failed, skipped };
}

/** Best-effort: if a task just started (Proposed -> InProgress), and its
 * parent story is itself still in a Proposed-category state, move the story
 * forward too. The parent's target state is resolved from the PARENT's own
 * type — a story's workflow is not its task's, on any process template — so
 * this never writes a Task state onto a User Story. A failure here must never
 * surface as a failure of the hours write that triggered it: the task write
 * already succeeded and stands on its own. Returns the parent's id if it was
 * advanced, otherwise null. */
async function cascadeActivateParentStory(client, taskId, statesByType) {
  try {
    const parentId = await resolveParentId(client, taskId);
    if (!parentId) return null;

    const parent = await fetchCurrentState(client, parentId);
    const parentWorkflow = resolveWorkflow(parent.type, statesByType);
    if (!parentWorkflow.known) return null;
    // Same initial-state rule as resolveAutoActivate, and for the same reason:
    // this org's User Story workflow has four Proposed states, and a story
    // someone moved to 'Ready For Development' is not an untouched one.
    if (!parentWorkflow.initialState || parent.state !== parentWorkflow.initialState.name) return null;
    const target = parentWorkflow.inProgressState;
    if (!target) return null;

    await client.patch(`/wit/workitems/${parentId}`, [
      { op: 'test', path: '/rev', value: parent.rev },
      { op: 'add', path: STATE_PATH, value: target.name },
    ]);
    return parentId;
  } catch (err) {
    return null;
  }
}

/** Validates and rejects BEFORE any write is attempted — logging hours that
 * would push completed past the estimate is refused outright, per your
 * request, rather than silently clamped. */
function assertWithinEstimate(current, newCompleted) {
  if (current.estimated > 0 && newCompleted > current.estimated) {
    const roomLeft = Math.max(0, round2(current.estimated - current.completed));
    throw new ValidationError(
      `Only ${roomLeft}h of room left before the ${current.estimated}h estimate ` +
        `(${current.completed}h already logged) — that entry would put completed work at ${newCompleted}h. ` +
        `Adjust the estimate in Azure DevOps first if it's genuinely under-scoped.`
    );
  }
}

function computeLogHours(current, hoursToday) {
  if (!(hoursToday > 0)) throw new ValidationError('Enter a positive number of hours.');
  const newCompleted = round2(current.completed + hoursToday);
  assertWithinEstimate(current, newCompleted);
  const newRemaining = current.estimated > 0
    ? round2(Math.max(0, current.estimated - newCompleted))
    : round2(Math.max(0, current.remaining - hoursToday));
  return { newCompleted, newRemaining };
}

function computeSetProgress(current, pct) {
  if (!(pct >= 0 && pct <= 100)) throw new ValidationError('Percent must be between 0 and 100.');
  if (!(current.estimated > 0)) {
    throw new ValidationError('This task has no Original Estimate set, so a percentage can\'t be converted to hours.');
  }
  const newCompleted = round2((pct / 100) * current.estimated);
  assertWithinEstimate(current, newCompleted);
  const newRemaining = round2(Math.max(0, current.estimated - newCompleted));
  return { newCompleted, newRemaining };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Lightweight read used by the state-only write path and the parent-story
 * cascade — just enough to validate and PATCH safely. */
async function fetchCurrentState(client, id) {
  const item = await client.get(`/wit/workitems/${id}`, { query: { fields: 'System.State,System.WorkItemType,System.AssignedTo' } });
  const f = item.fields || {};
  return {
    rev: item.rev,
    state: f['System.State'] || null,
    type: f['System.WorkItemType'] || null,
    assignedToId: f['System.AssignedTo'] ? f['System.AssignedTo'].id : null,
  };
}

/** Lightweight read used by the move-to-parent-sprint write — just enough
 * to validate ownership and PATCH safely. */
async function fetchCurrentIteration(client, id) {
  const item = await client.get(`/wit/workitems/${id}`, {
    query: { fields: 'System.IterationPath,System.WorkItemType,System.AssignedTo' },
  });
  const f = item.fields || {};
  return {
    rev: item.rev,
    iterationPath: f['System.IterationPath'] || null,
    type: f['System.WorkItemType'] || null,
    assignedToId: f['System.AssignedTo'] ? f['System.AssignedTo'].id : null,
  };
}

/**
 * Moves a task/bug onto its parent story's current iteration — the fix for
 * "a story moved sprints, but its children kept their old IterationPath".
 * The target path is never taken from the client: it's resolved here from
 * the item's real parent in Azure DevOps, so there's no arbitrary path to
 * validate and no way for a stale/hand-crafted request to write a bogus
 * iteration.
 *
 * IS assignee-gated (unlike applyStateWrite) — this only ever targets leaf
 * Task/Bug items, which are assigned to the caller by construction (the
 * sync WIQL filters on exactly that), so the check never blocks a
 * legitimate move.
 */
async function applyMoveToParentIteration(client, id, expectedAssigneeId) {
  const current = await fetchCurrentIteration(client, id);
  assertAssignedTo(current, expectedAssigneeId);

  const parentId = await resolveParentId(client, id);
  if (!parentId) {
    throw new ValidationError('This item has no parent story, so there is no sprint to move it to.');
  }
  const parent = await fetchCurrentIteration(client, parentId);
  if (!parent.iterationPath) {
    throw new ValidationError("The parent story has no sprint set, so there's nothing to move this item to.");
  }

  if (parent.iterationPath === current.iterationPath) {
    return { id, rev: current.rev, iterationPath: current.iterationPath, moved: false };
  }

  const updated = await client.patch(`/wit/workitems/${id}`, [
    { op: 'test', path: '/rev', value: current.rev },
    { op: 'add', path: ITERATION_PATH, value: parent.iterationPath },
  ]);

  return { id, rev: updated.rev, iterationPath: parent.iterationPath, moved: true };
}

/**
 * Direct state change (the manual picker), independent of the hours write
 * path. Validates against the real states for the item's type — supplied
 * by the caller (server/ado/states.js, cached 24h) — so a stale or
 * hand-crafted request can't set a state that doesn't exist for that type.
 *
 * Deliberately NOT assignee-gated the way applyTaskWrite is: a parent User
 * Story/Bug can legitimately reach someone's dashboard because a CHILD task
 * is assigned to them, while the story itself is assigned to someone else
 * entirely (verified live — most stories on a real dashboard are in this
 * shape). Changing that story's own state is expected to work from your
 * dashboard regardless. Leaf Task/Bug writes always ARE assigned to the
 * caller by construction (the sync query filters on exactly that), so no
 * legitimate state change is weakened by skipping the check here.
 */
async function applyStateWrite(client, id, newState, statesByType) {
  const current = await fetchCurrentState(client, id);
  const workflow = resolveWorkflow(current.type, statesByType);
  // Refusing when the workflow is UNKNOWN is deliberate, and a change from
  // the earlier behavior of letting anything through in that case. An empty
  // list means this project never told us what states exist for the type, so
  // there is nothing to validate against — and sending an unvalidated state
  // is how a request hand-crafted (or replayed from another project, on a
  // different process template) reaches Azure DevOps as an invalid write.
  if (!workflow.known) {
    throw new ValidationError(
      `Azure DevOps hasn't returned the available states for ${current.type || 'this work item type'} ` +
        `in this project, so the change can't be validated. Try "Reload All Data" from the account menu, ` +
        `then retry.`
    );
  }
  if (!workflow.allows(newState)) {
    const options = workflow.states.map((s) => s.name).join(', ');
    throw new ValidationError(
      `"${newState}" is not one of the states ${current.type} uses in this project. Available: ${options}.`
    );
  }
  if (newState === current.state) {
    return { id, rev: current.rev, state: current.state };
  }

  const updated = await client.patch(`/wit/workitems/${id}`, [
    { op: 'test', path: '/rev', value: current.rev },
    { op: 'add', path: STATE_PATH, value: newState },
  ]);

  return { id, rev: updated.rev, state: newState };
}

/**
 * Shared read-modify-write: fetch fresh state, run `computeFn(current)` to
 * get the new hours (throws ValidationError to abort before any write),
 * then PATCH with an optimistic-concurrency `test` on `rev` so a
 * concurrent edit in Azure DevOps causes a 409 instead of being overwritten.
 */
async function applyTaskWrite(client, id, computeFn, expectedAssigneeId, statesByType, types) {
  const current = await fetchCurrentTaskHours(client, id);
  assertAssignedTo(current, expectedAssigneeId);
  // 007-all-assigned-types: any type can now reach the dashboard, and not
  // every type carries Completed Work (a Feature or Epic doesn't). Refused
  // HERE — after the ownership check, before any PATCH — rather than letting
  // ADO reject the write with an opaque error. The UI hiding the hours editor
  // (`hoursEditable`) is a courtesy; this is the enforcement (Principle III,
  // research.md R5). Unknown hours capability is permissive (typeTracksHours).
  if (!typeTracksHours(current.type, types)) {
    const err = new ValidationError(`Work items of type "${current.type}" don't track hours in this project.`);
    err.code = 'TYPE_NO_HOURS';
    err.details = { type: current.type };
    throw err;
  }
  const { newCompleted, newRemaining } = computeFn(current);
  // Both transitions come from this item's own type in this project. When the
  // project's process has no suitable state (or we don't know its states), the
  // hours still land — only the state patch is dropped.
  const workflow = resolveWorkflow(current.type, statesByType);
  const autoClose = resolveAutoClose(current, newCompleted, workflow);
  const autoActivate = resolveAutoActivate(current, newCompleted, workflow, !!autoClose);

  // JSON Patch 'add' on an existing property replaces it and on a missing
  // one creates it — using 'add' uniformly sidesteps having to know whether
  // CompletedWork/RemainingWork were ever previously set on this task.
  // The state change rides in the SAME patch as the hours, so the two can
  // never half-apply and both sit under the one `test /rev` guard.
  const patchDocument = [
    { op: 'test', path: '/rev', value: current.rev },
    { op: 'add', path: COMPLETED_WORK_PATH, value: newCompleted },
    { op: 'add', path: REMAINING_WORK_PATH, value: newRemaining },
    ...(autoClose ? [{ op: 'add', path: STATE_PATH, value: autoClose.name }] : []),
    ...(autoActivate ? [{ op: 'add', path: STATE_PATH, value: autoActivate.name }] : []),
  ];

  const updated = await client.patch(`/wit/workitems/${id}`, patchDocument);

  // Best-effort, after the task write is already durable: if the task just
  // went New -> Active, nudge its parent story the same way when it's
  // still sitting at New. Never allowed to fail the response.
  let storyActivated = null;
  if (autoActivate) {
    storyActivated = await cascadeActivateParentStory(client, id, statesByType);
  }

  return {
    id,
    rev: updated.rev,
    hours: { estimated: current.estimated, completed: newCompleted, remaining: newRemaining },
    // Kept boolean on the wire — the client renders "task closed"/"task
    // started" messages off these and never needed the state name itself.
    closed: !!autoClose,
    activated: !!autoActivate,
    storyActivated: storyActivated != null,
    newState: autoClose ? autoClose.name : autoActivate ? autoActivate.name : current.state,
  };
}

module.exports = {
  ValidationError,
  ForbiddenError,
  fetchCurrentTaskHours,
  computeLogHours,
  computeSetProgress,
  applyTaskWrite,
  applyStateWrite,
  applyMoveToParentIteration,
  applyMoveChildrenToStoryIteration,
  // Exported for the unit tests in test/ — the transition decisions are the
  // part that used to be hardcoded, so they're the part worth pinning down.
  resolveAutoClose,
  resolveAutoActivate,
};

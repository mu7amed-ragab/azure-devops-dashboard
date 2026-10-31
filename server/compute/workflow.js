/**
 * Process-independent workflow resolution.
 *
 * Azure DevOps state NAMES are a property of the project's process template:
 * Agile calls a finished Task 'Closed', Scrum and Basic call it 'Done', CMMI
 * calls it 'Closed' again, and an inherited/custom process can call it
 * anything at all ('Deployed To Production' is a real one in this org). Every
 * state does, however, carry a `category` — one of ADO's five fixed buckets
 * (Proposed | InProgress | Resolved | Completed | Removed) — and those are
 * the same on every process template, custom ones included.
 *
 * So: nothing in this app may branch on a state name. It branches on the
 * category of the state, read from the states the CURRENT project actually
 * returned for that work item type (server/ado/states.js, cached per project
 * in that project's own cache directory — see server/scopes.js). Two projects
 * on two different templates get two different answers from the same code,
 * which is the whole point.
 */

/** Anything past "work is happening": test/review stages (Resolved), the
 * terminal state (Completed), and deleted items (Removed). Reaching 100%
 * again must not drag one of these backwards. */
const DONE_CATEGORIES = new Set(['Resolved', 'Completed', 'Removed']);

/** Only consulted when a type's workflow offers MORE than one state in the
 * Completed / InProgress category, which no stock template does — a custom
 * process might. Preferring the conventional name over ADO's arbitrary
 * ordering keeps the automatic transition predictable for anyone who has
 * seen the stock templates. */
const PREFERRED_COMPLETED = ['Closed', 'Done', 'Completed'];
const PREFERRED_IN_PROGRESS = ['Active', 'In Progress', 'Committed', 'Doing', 'Resolved'];

function pick(candidates, preferred) {
  if (candidates.length === 0) return null;
  for (const name of preferred) {
    const hit = candidates.find((s) => s.name === name);
    if (hit) return hit;
  }
  return candidates[0];
}

/**
 * Everything the write paths need to know about one work item type's real
 * workflow in the current project.
 *
 * @param {string|null} type e.g. 'Task', 'Product Backlog Item', 'Issue'
 * @param {Object<string, Array<{name:string, category:string}>>} statesByType
 *   the per-project, per-type state map from server/ado/states.js
 * @returns {{
 *   type: string|null,
 *   known: boolean,              // false when this project never told us about `type`
 *   states: Array,
 *   completedState: {name:string,category:string}|null,
 *   inProgressState: {name:string,category:string}|null,
 *   initialState: {name:string,category:string}|null,
 *   proposedNames: Set<string>,
 *   doneNames: Set<string>,
 *   allows(name): boolean,
 * }}
 *
 * `known: false` is load-bearing: it means "this project has not told us what
 * states exist for this type", and every caller must then refuse to write a
 * state rather than guess one. Guessing is exactly the bug this module exists
 * to remove.
 */
function resolveWorkflow(type, statesByType) {
  const list = (statesByType && type && statesByType[type]) || [];
  const inCategory = (category) => list.filter((s) => s.category === category);
  const names = new Set(list.map((s) => s.name));
  return {
    type: type || null,
    known: list.length > 0,
    states: list,
    completedState: pick(inCategory('Completed'), PREFERRED_COMPLETED),
    inProgressState: pick(inCategory('InProgress'), PREFERRED_IN_PROGRESS),
    // The state a brand-new item of this type is created in: the FIRST
    // Proposed-category state in the order ADO returned, which is the process's
    // own workflow order.
    //
    // Not "any Proposed state", and the difference is load-bearing. Verified
    // against this org's live workflows: ProjectA' Task type reads
    // New [Proposed] -> OnHold [Proposed] -> Active [InProgress] -> ..., and its
    // User Story has FOUR Proposed states (New, PO Approved, EA Approved, Ready
    // For Development). "Not started" in ADO's category sense therefore includes
    // states a person deliberately parked an item in — auto-advancing out of
    // OnHold because someone logged an hour would be wrong, and would also be a
    // behavior change, since the code this replaced only ever advanced from the
    // literal 'New'. The initial state is the one that genuinely means untouched.
    initialState: inCategory('Proposed')[0] || null,
    proposedNames: new Set(inCategory('Proposed').map((s) => s.name)),
    doneNames: new Set(list.filter((s) => DONE_CATEGORIES.has(s.category)).map((s) => s.name)),
    allows: (name) => names.has(name),
  };
}

module.exports = { resolveWorkflow, DONE_CATEGORIES };

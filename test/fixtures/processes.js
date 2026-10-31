/**
 * The four stock Azure DevOps process templates, plus one inherited/custom one,
 * as the API actually returns them.
 *
 * These are the real shapes of two endpoints:
 *   GET /wit/workitemtypecategories  -> `categories`
 *   GET /wit/workitemtypes/{t}/states -> `states[type]`
 *
 * State names and their `category` values are taken from the stock templates.
 * The `custom` fixture is modelled on this org's own inherited process (verified
 * live: 'Deployed To Production' as a real Completed-category state alongside
 * 'Closed', and a Resolved-category 'Ready For Test (Demo)') — it is the reason
 * nothing may branch on a state NAME.
 */

function category(referenceName, types) {
  return { referenceName, name: referenceName, workItemTypes: types.map((name) => ({ name })) };
}

/** 007-all-assigned-types: the stock Feature/Epic workflow, plus any extra
 * states a type adds. */
function planningStates(extra = []) {
  return [
    { name: 'New', category: 'Proposed' },
    { name: 'Active', category: 'InProgress' },
    ...extra,
    { name: 'Resolved', category: 'Resolved' },
    { name: 'Closed', category: 'Completed' },
    { name: 'Removed', category: 'Removed' },
  ];
}

/** 007-all-assigned-types: which types carry Completed Work, as
 * `GET /wit/workitemtypes` reports each type's `fields` — see
 * test/fixtures/fakeClient.js. Requirement and planning types deliberately
 * don't. A process without `typeFields` reports no fields at all. */
const COMPLETED_WORK = 'Microsoft.VSTS.Scheduling.CompletedWork';
const TRACKS_HOURS_FIELDS = {
  Task: [COMPLETED_WORK],
  Bug: [COMPLETED_WORK],
  Chore: [COMPLETED_WORK],
  Defect: [COMPLETED_WORK],
  Impediment: [COMPLETED_WORK],
};

const AGILE = {
  name: 'Agile',
  categories: [
    category('Microsoft.RequirementCategory', ['User Story']),
    category('Microsoft.TaskCategory', ['Task']),
    category('Microsoft.BugCategory', ['Bug']),
    category('Microsoft.EpicCategory', ['Epic']),
    category('Microsoft.FeatureCategory', ['Feature']),
  ],
  // The story-level estimate field this template's requirement type carries —
  // server/ado/estimateField.js discovers this per project rather than
  // assuming it. See test/fixtures/fakeClient.js's handling of
  // GET /wit/workitemtypes/{type}.
  fields: { 'User Story': ['Microsoft.VSTS.Scheduling.StoryPoints'] },
  states: {
    'User Story': [
      { name: 'New', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Resolved', category: 'Resolved' },
      { name: 'Closed', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
    Task: [
      { name: 'New', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Closed', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
    Bug: [
      { name: 'New', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Resolved', category: 'Resolved' },
      { name: 'Closed', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
    // 007-all-assigned-types: planning types outside the requirement/task/bug
    // families. Epic's 'Funded' is a state name no other type here uses.
    Feature: planningStates(),
    Epic: planningStates([{ name: 'Funded', category: 'InProgress' }]),
  },
  typeFields: TRACKS_HOURS_FIELDS,
};

const SCRUM = {
  name: 'Scrum',
  categories: [
    category('Microsoft.RequirementCategory', ['Product Backlog Item']),
    category('Microsoft.TaskCategory', ['Task']),
    category('Microsoft.BugCategory', ['Bug']),
    category('Microsoft.EpicCategory', ['Epic']),
    category('Microsoft.FeatureCategory', ['Feature']),
  ],
  fields: { 'Product Backlog Item': ['Microsoft.VSTS.Scheduling.Effort'] },
  typeFields: TRACKS_HOURS_FIELDS,
  states: {
    'Product Backlog Item': [
      { name: 'New', category: 'Proposed' },
      { name: 'Approved', category: 'Proposed' },
      { name: 'Committed', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
    Task: [
      { name: 'To Do', category: 'Proposed' },
      { name: 'In Progress', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
    Bug: [
      { name: 'New', category: 'Proposed' },
      { name: 'Approved', category: 'Proposed' },
      { name: 'Committed', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
    Feature: planningStates(),
    Epic: planningStates([{ name: 'Funded', category: 'InProgress' }]),
  },
};

const BASIC = {
  name: 'Basic',
  categories: [
    category('Microsoft.RequirementCategory', ['Issue']),
    category('Microsoft.TaskCategory', ['Task']),
    // Basic genuinely has no bug category.
  ],
  // Basic genuinely has no story-level estimate field either — this is the
  // fixture FR-013a's "velocity unavailable" test exercises.
  states: {
    Issue: [
      { name: 'To Do', category: 'Proposed' },
      { name: 'Doing', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
    ],
    Task: [
      { name: 'To Do', category: 'Proposed' },
      { name: 'Doing', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
    ],
  },
};

const CMMI = {
  name: 'CMMI',
  categories: [
    category('Microsoft.RequirementCategory', ['Requirement']),
    category('Microsoft.TaskCategory', ['Task']),
    category('Microsoft.BugCategory', ['Bug']),
  ],
  fields: { Requirement: ['Microsoft.VSTS.Scheduling.Size'] },
  states: {
    Requirement: [
      { name: 'Proposed', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Resolved', category: 'Resolved' },
      { name: 'Closed', category: 'Completed' },
    ],
    Task: [
      { name: 'Proposed', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Closed', category: 'Completed' },
    ],
    Bug: [
      { name: 'Proposed', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Resolved', category: 'Resolved' },
      { name: 'Closed', category: 'Completed' },
    ],
  },
};

/** An inherited process: renamed requirement type, extra workflow stages, and a
 * Completed-category state that is NOT called 'Closed'. */
const CUSTOM = {
  name: 'Custom',
  categories: [
    category('Microsoft.RequirementCategory', ['Delivery Item']),
    category('Microsoft.TaskCategory', ['Task', 'Chore']),
    category('Microsoft.BugCategory', ['Defect']),
    category('Custom.ImpedimentCategory', ['Impediment']),
  ],
  fields: { 'Delivery Item': ['Microsoft.VSTS.Scheduling.StoryPoints'] },
  typeFields: TRACKS_HOURS_FIELDS,
  states: {
    'Delivery Item': [
      { name: 'Intake', category: 'Proposed' },
      { name: 'Building', category: 'InProgress' },
      { name: 'Ready For Test (Demo)', category: 'Resolved' },
      { name: 'Deployed To Production', category: 'Completed' },
    ],
    Task: [
      { name: 'Intake', category: 'Proposed' },
      { name: 'Building', category: 'InProgress' },
      { name: 'Deployed To Production', category: 'Completed' },
    ],
    Chore: [
      { name: 'Intake', category: 'Proposed' },
      { name: 'Building', category: 'InProgress' },
      { name: 'Deployed To Production', category: 'Completed' },
    ],
    Defect: [
      { name: 'Intake', category: 'Proposed' },
      { name: 'Building', category: 'InProgress' },
      { name: 'Verified and Resolved', category: 'Resolved' },
      { name: 'Deployed To Production', category: 'Completed' },
    ],
    // 007-all-assigned-types: a custom type outside every stock family that
    // tracks hours, with a Removed-CATEGORY state whose name is not
    // 'Removed' — the reason Removed items are excluded by category.
    Impediment: [
      { name: 'Open', category: 'Proposed' },
      { name: 'Closed', category: 'Completed' },
      { name: 'Cut', category: 'Removed' },
    ],
  },
};

/**
 * Two REAL workflows, read live from this org via GET /api/states and pasted in
 * verbatim. They are here because they break assumptions the stock templates
 * don't:
 *
 *  - `Task` has OnHold in the **Proposed** category, so "any Proposed state
 *    means untouched" is false: auto-advancing an item out of OnHold because
 *    someone logged an hour would be wrong.
 *  - `User Story` has FOUR Proposed states and puts 'Resolved' in the
 *    **InProgress** category — the old hardcoded ALREADY_DONE_STATES listed
 *    'Resolved' as finished, which was simply wrong for this type here.
 *  - `Deployed To Production` is Resolved, not Completed, and `Closed` is the
 *    only Completed state.
 *  - The second project (same org, same PAT) has a different Task workflow
 *    again, with Blocked in InProgress.
 */
const LIVE_A = {
  name: 'LiveProjectA',
  categories: [
    category('Microsoft.RequirementCategory', ['User Story']),
    category('Microsoft.TaskCategory', ['Task']),
    category('Microsoft.BugCategory', ['Bug']),
  ],
  fields: { 'User Story': ['Microsoft.VSTS.Scheduling.StoryPoints'] },
  states: {
    'User Story': [
      { name: 'New', category: 'Proposed' },
      { name: 'PO Approved', category: 'Proposed' },
      { name: 'EA Approved', category: 'Proposed' },
      { name: 'Ready For Development', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'OnHold', category: 'InProgress' },
      { name: 'Resolved', category: 'InProgress' },
      { name: 'Ready For Test (Demo)', category: 'InProgress' },
      { name: 'blocked', category: 'InProgress' },
      { name: 'Ready for Production', category: 'Resolved' },
      { name: 'Deployed To Production', category: 'Resolved' },
      { name: 'Closed', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
    Task: [
      { name: 'New', category: 'Proposed' },
      { name: 'OnHold', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Deployed To Production', category: 'Resolved' },
      { name: 'Closed', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
  },
};

const LIVE_B = {
  name: 'LiveProjectB',
  categories: [
    category('Microsoft.RequirementCategory', ['User Story']),
    category('Microsoft.TaskCategory', ['Task']),
    category('Microsoft.BugCategory', ['Bug']),
  ],
  states: {
    'User Story': [
      { name: 'New', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Resolved', category: 'InProgress' },
      { name: 'Closed', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
    Task: [
      { name: 'New', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Blocked', category: 'InProgress' },
      { name: 'Closed', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ],
  },
};

/** A type whose workflow this project never reported — the "unknown" case every
 * write path has to refuse rather than guess at. */
const UNKNOWN_TYPE = 'Spike';

module.exports = { AGILE, SCRUM, BASIC, CMMI, CUSTOM, LIVE_A, LIVE_B, UNKNOWN_TYPE };

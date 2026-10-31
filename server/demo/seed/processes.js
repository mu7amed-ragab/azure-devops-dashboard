/**
 * Three process templates for the three demo projects, in the shapes Azure
 * DevOps returns them — so the app's own discovery (work item type
 * categories, per-type states, per-type fields) finds three different
 * workflows, exactly as it would across real projects.
 */

const SCHEDULING = [
  'Microsoft.VSTS.Scheduling.OriginalEstimate',
  'Microsoft.VSTS.Scheduling.RemainingWork',
  'Microsoft.VSTS.Scheduling.CompletedWork',
];
const COMMON = ['System.Id', 'System.Title', 'System.State', 'System.AssignedTo', 'System.IterationPath', 'System.Tags'];

function st(name, category, color) {
  return { name, category, color };
}

const AGILE_STATES = {
  Epic: [st('New', 'Proposed', 'b2b2b2'), st('Active', 'InProgress', '007acc'), st('Resolved', 'Resolved', 'ff9d00'), st('Closed', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  Feature: [st('New', 'Proposed', 'b2b2b2'), st('Active', 'InProgress', '007acc'), st('Resolved', 'Resolved', 'ff9d00'), st('Closed', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  'User Story': [st('New', 'Proposed', 'b2b2b2'), st('Active', 'InProgress', '007acc'), st('Resolved', 'Resolved', 'ff9d00'), st('Closed', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  Task: [st('New', 'Proposed', 'b2b2b2'), st('On Hold', 'Proposed', 'cccccc'), st('Active', 'InProgress', '007acc'), st('Closed', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  Bug: [st('New', 'Proposed', 'b2b2b2'), st('Active', 'InProgress', '007acc'), st('Resolved', 'Resolved', 'ff9d00'), st('Closed', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
};

const SCRUM_STATES = {
  Epic: [st('New', 'Proposed', 'b2b2b2'), st('In Progress', 'InProgress', '007acc'), st('Done', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  Feature: [st('New', 'Proposed', 'b2b2b2'), st('In Progress', 'InProgress', '007acc'), st('Done', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  'Product Backlog Item': [st('New', 'Proposed', 'b2b2b2'), st('Approved', 'Proposed', '5688e0'), st('Committed', 'InProgress', '007acc'), st('Done', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  Task: [st('To Do', 'Proposed', 'b2b2b2'), st('In Progress', 'InProgress', '007acc'), st('Done', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  Bug: [st('New', 'Proposed', 'b2b2b2'), st('Approved', 'Proposed', '5688e0'), st('Committed', 'InProgress', '007acc'), st('Done', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  Impediment: [st('Open', 'InProgress', 'b2b2b2'), st('Closed', 'Completed', '339933')],
};

const CUSTOM_STATES = {
  ...AGILE_STATES,
  Task: [st('New', 'Proposed', 'b2b2b2'), st('On Hold', 'Proposed', 'cccccc'), st('Active', 'InProgress', '007acc'), st('Closed', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
  Spike: [st('New', 'Proposed', 'b2b2b2'), st('Investigating', 'InProgress', '8661c5'), st('Concluded', 'Completed', '339933'), st('Removed', 'Removed', 'ffffff')],
};

function category(referenceName, name, types) {
  return {
    referenceName,
    name,
    defaultWorkItemType: { name: types[0] },
    workItemTypes: types.map((t) => ({ name: t })),
  };
}

function agileFields(estimate) {
  return {
    Epic: [...COMMON, estimate],
    Feature: [...COMMON, estimate],
    'User Story': [...COMMON, estimate],
    Task: [...COMMON, ...SCHEDULING, 'Microsoft.VSTS.CMMI.Blocked'],
    Bug: [...COMMON, ...SCHEDULING, estimate],
  };
}

const AGILE = {
  key: 'agile',
  requirementType: 'User Story',
  taskType: 'Task',
  bugType: 'Bug',
  featureType: 'Feature',
  epicType: 'Epic',
  estimateField: 'Microsoft.VSTS.Scheduling.StoryPoints',
  blockedField: 'Microsoft.VSTS.CMMI.Blocked',
  categories: [
    category('Microsoft.EpicCategory', 'Epic Category', ['Epic']),
    category('Microsoft.FeatureCategory', 'Feature Category', ['Feature']),
    category('Microsoft.RequirementCategory', 'Requirement Category', ['User Story']),
    category('Microsoft.TaskCategory', 'Task Category', ['Task']),
    category('Microsoft.BugCategory', 'Bug Category', ['Bug']),
  ],
  states: AGILE_STATES,
  fields: agileFields('Microsoft.VSTS.Scheduling.StoryPoints'),
};

const SCRUM = {
  key: 'scrum',
  requirementType: 'Product Backlog Item',
  taskType: 'Task',
  bugType: 'Bug',
  featureType: 'Feature',
  epicType: 'Epic',
  estimateField: 'Microsoft.VSTS.Scheduling.Effort',
  blockedField: null,
  categories: [
    category('Microsoft.EpicCategory', 'Epic Category', ['Epic']),
    category('Microsoft.FeatureCategory', 'Feature Category', ['Feature']),
    category('Microsoft.RequirementCategory', 'Requirement Category', ['Product Backlog Item']),
    category('Microsoft.TaskCategory', 'Task Category', ['Task']),
    category('Microsoft.BugCategory', 'Bug Category', ['Bug']),
    category('Microsoft.ImpedimentCategory', 'Impediment Category', ['Impediment']),
  ],
  states: SCRUM_STATES,
  fields: {
    Epic: [...COMMON, 'Microsoft.VSTS.Scheduling.Effort'],
    Feature: [...COMMON, 'Microsoft.VSTS.Scheduling.Effort'],
    'Product Backlog Item': [...COMMON, 'Microsoft.VSTS.Scheduling.Effort'],
    Task: [...COMMON, 'Microsoft.VSTS.Scheduling.RemainingWork', 'Microsoft.VSTS.Scheduling.CompletedWork', 'Microsoft.VSTS.Scheduling.OriginalEstimate'],
    Bug: [...COMMON, ...SCHEDULING, 'Microsoft.VSTS.Scheduling.Effort'],
    Impediment: [...COMMON],
  },
};

// An inherited Agile process with one custom type and one extra state. `Spike`
// is deliberately in no category — the shape of a custom type added without a
// backlog level — so the app shows it as a plain item, never as a story.
const CUSTOM = {
  ...AGILE,
  key: 'custom',
  categories: AGILE.categories,
  states: CUSTOM_STATES,
  fields: { ...agileFields('Microsoft.VSTS.Scheduling.StoryPoints'), Spike: [...COMMON, ...SCHEDULING] },
  spikeType: 'Spike',
};

/** Field definitions for `GET /wit/fields` — only `type` matters to the app
 * (it offers boolean/picklist fields as blocked-convention candidates). */
const FIELD_DEFINITIONS = [
  { referenceName: 'System.Title', name: 'Title', type: 'string' },
  { referenceName: 'System.State', name: 'State', type: 'string' },
  { referenceName: 'System.Tags', name: 'Tags', type: 'plainText' },
  { referenceName: 'Microsoft.VSTS.CMMI.Blocked', name: 'Blocked', type: 'picklistString' },
  { referenceName: 'Microsoft.VSTS.Common.Priority', name: 'Priority', type: 'picklistInteger' },
  { referenceName: 'Microsoft.VSTS.Scheduling.StoryPoints', name: 'Story Points', type: 'double' },
  { referenceName: 'Microsoft.VSTS.Scheduling.Effort', name: 'Effort', type: 'double' },
  { referenceName: 'Microsoft.VSTS.Scheduling.RemainingWork', name: 'Remaining Work', type: 'double' },
  { referenceName: 'Microsoft.VSTS.Scheduling.CompletedWork', name: 'Completed Work', type: 'double' },
  { referenceName: 'Microsoft.VSTS.Scheduling.OriginalEstimate', name: 'Original Estimate', type: 'double' },
];

/** The process's state list for a type, or [] for a type it doesn't have. */
function statesOf(proc, type) {
  return proc.states[type] || [];
}

function stateIn(proc, type, categoryName, nth = 0) {
  const list = statesOf(proc, type).filter((s) => s.category === categoryName);
  return list[nth] ? list[nth].name : null;
}

module.exports = { AGILE, SCRUM, CUSTOM, FIELD_DEFINITIONS, statesOf, stateIn };

/**
 * (C) in the brief: "Project A state list != Project B state list if they
 * differ" — and the layer that makes that safe to act on.
 *
 * resolveWorkflow is what replaced the hardcoded 'Closed' / ALREADY_DONE_STATES
 * in server/ado/writeback.js. Every one of these cases would have been answered
 * with an Agile state name before.
 */

const { suite, test, run, assert } = require('./harness');
const { resolveWorkflow } = require('../server/compute/workflow');
const { fetchWorkItemTypes, shape, FALLBACK } = require('../server/ado/workItemTypes');
const { createFakeClient } = require('./fixtures/fakeClient');
const { AGILE, SCRUM, BASIC, CMMI, CUSTOM, UNKNOWN_TYPE } = require('./fixtures/processes');

suite('resolveWorkflow: the terminal state is whatever THIS process calls it');

const TERMINAL = [
  [AGILE, 'Task', 'Closed'],
  [SCRUM, 'Task', 'Done'],
  [BASIC, 'Task', 'Done'],
  [CMMI, 'Task', 'Closed'],
  [CUSTOM, 'Task', 'Deployed To Production'],
];

for (const [proc, type, expected] of TERMINAL) {
  test(`${proc.name}: ${type} completes at "${expected}"`, () => {
    const wf = resolveWorkflow(type, proc.states);
    assert.ok(wf.known, 'workflow should be known');
    assert.strictEqual(wf.completedState.name, expected);
    assert.strictEqual(wf.completedState.category, 'Completed');
  });
}

const ACTIVE = [
  [AGILE, 'Task', 'Active'],
  [SCRUM, 'Task', 'In Progress'],
  [BASIC, 'Task', 'Doing'],
  [CMMI, 'Task', 'Active'],
  [CUSTOM, 'Task', 'Building'],
];

for (const [proc, type, expected] of ACTIVE) {
  test(`${proc.name}: ${type} starts at "${expected}"`, () => {
    const wf = resolveWorkflow(type, proc.states);
    assert.strictEqual(wf.inProgressState.name, expected);
  });
}

test('Scrum has TWO Proposed states and both count as "not started"', () => {
  const wf = resolveWorkflow('Product Backlog Item', SCRUM.states);
  assert.ok(wf.proposedNames.has('New'));
  assert.ok(wf.proposedNames.has('Approved'));
  assert.ok(!wf.proposedNames.has('Committed'));
});

test('a custom Resolved-category state is "done" even though it is not terminal', () => {
  const wf = resolveWorkflow('Delivery Item', CUSTOM.states);
  assert.ok(wf.doneNames.has('Ready For Test (Demo)'), 'Resolved category counts as done');
  assert.ok(wf.doneNames.has('Deployed To Production'), 'Completed category counts as done');
  assert.ok(!wf.doneNames.has('Building'), 'InProgress does not');
  assert.ok(!wf.doneNames.has('Intake'), 'Proposed does not');
});

test('an unreported type is `known: false`, never a guess', () => {
  const wf = resolveWorkflow(UNKNOWN_TYPE, AGILE.states);
  assert.strictEqual(wf.known, false);
  assert.strictEqual(wf.completedState, null);
  assert.strictEqual(wf.inProgressState, null);
  assert.strictEqual(wf.allows('Closed'), false);
});

test('a null type is `known: false` rather than throwing', () => {
  const wf = resolveWorkflow(null, AGILE.states);
  assert.strictEqual(wf.known, false);
});

test('allows() answers from this project only — Agile does not allow a Scrum state', () => {
  const agile = resolveWorkflow('Task', AGILE.states);
  assert.strictEqual(agile.allows('Closed'), true);
  assert.strictEqual(agile.allows('Done'), false, "'Done' is Scrum's, not Agile's");
  const scrum = resolveWorkflow('Task', SCRUM.states);
  assert.strictEqual(scrum.allows('Done'), true);
  assert.strictEqual(scrum.allows('Closed'), false);
});

suite('work item type discovery: names come from the process, not the code');

const TYPES = [
  [AGILE, 'User Story', 'Task', 'Bug'],
  [SCRUM, 'Product Backlog Item', 'Task', 'Bug'],
  [CMMI, 'Requirement', 'Task', 'Bug'],
];

for (const [proc, requirement, task, bug] of TYPES) {
  test(`${proc.name}: requirement type is "${requirement}"`, async () => {
    const types = await fetchWorkItemTypes(createFakeClient({ project: 'P', process: proc }));
    assert.strictEqual(types.source, 'categories');
    assert.deepStrictEqual(types.requirementTypes, [requirement]);
    assert.deepStrictEqual(types.taskTypes, [task]);
    assert.deepStrictEqual(types.bugTypes, [bug]);
    // A bug is BOTH a story-like container and a leaf, matching the semantics
    // the old hardcoded lists had.
    assert.deepStrictEqual(types.storyTypes, [requirement, bug]);
    assert.deepStrictEqual(types.leafTypes, [task, bug]);
  });
}

test('Basic has no bug type at all and does not invent one', async () => {
  const types = await fetchWorkItemTypes(createFakeClient({ project: 'P', process: BASIC }));
  assert.deepStrictEqual(types.bugTypes, []);
  assert.deepStrictEqual(types.storyTypes, ['Issue']);
  assert.deepStrictEqual(types.leafTypes, ['Task']);
});

test('a custom process with two task types keeps both', async () => {
  const types = await fetchWorkItemTypes(createFakeClient({ project: 'P', process: CUSTOM }));
  assert.deepStrictEqual(types.taskTypes, ['Task', 'Chore']);
  assert.deepStrictEqual(types.leafTypes, ['Task', 'Chore', 'Defect']);
  assert.deepStrictEqual(types.storyTypes, ['Delivery Item', 'Defect']);
});

test('allTypes is exactly what the state fetch should ask about', async () => {
  const types = await fetchWorkItemTypes(createFakeClient({ project: 'P', process: SCRUM }));
  assert.deepStrictEqual(types.allTypes.slice().sort(), ['Bug', 'Product Backlog Item', 'Task']);
});

test('a failing categories call degrades to stock Agile, flagged as a fallback', async () => {
  // No `process` fixture -> the endpoint throws, same as a PAT that cannot read
  // this project's work item metadata.
  const types = await fetchWorkItemTypes(createFakeClient({ project: 'P' }));
  assert.strictEqual(types.source, 'fallback');
  assert.deepStrictEqual(types.storyTypes, ['User Story', 'Bug']);
  assert.deepStrictEqual(types.leafTypes, ['Task', 'Bug']);
});

test('categories present but none of the three we need also falls back', async () => {
  const client = createFakeClient({
    project: 'P',
    process: { categories: [{ referenceName: 'Microsoft.TestCaseCategory', workItemTypes: [{ name: 'Test Case' }] }], states: {} },
  });
  const types = await fetchWorkItemTypes(client);
  assert.strictEqual(types.source, 'fallback');
  assert.deepStrictEqual(types.requirementTypes, shape(FALLBACK, 'fallback').requirementTypes);
});

module.exports = run;

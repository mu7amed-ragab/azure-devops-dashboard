/** US5: blocked (configured) + stalled items — the category asymmetry,
 * per-type conventions, tag/field matching, and duration rules. */

const { suite, test, run, assert } = require('./harness');
const { computeImpediments, workingDaysBetween } = require('../server/compute/impediments');

function item(overrides) {
  return {
    id: 1,
    title: 'Item',
    type: 'Task',
    state: 'New',
    stateCategory: 'Proposed',
    assignedTo: null,
    tags: [],
    blockedField: null,
    changedDate: '2026-01-01T00:00:00Z',
    url: 'https://x',
    ...overrides,
  };
}

const CONVENTION = {
  version: 1,
  byType: {
    'User Story': { states: ['OnHold', 'Blocked'], tags: [], field: null },
    Task: { states: ['OnHold'], tags: [], field: null },
  },
};

const TODAY = '2026-02-01T00:00:00Z'; // a Sunday

suite('US5 impediments: category asymmetry (FR-039, FR-039a)');

test('a blocked state ADO categorises Proposed is still reported blocked', () => {
  const items = [item({ id: 1, type: 'Task', state: 'OnHold', stateCategory: 'Proposed' })];
  const { items: result } = computeImpediments(items, CONVENTION, () => [], TODAY);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].condition, 'blocked');
});

test('stalled detection requires In Progress — a stale Proposed item is not stalled', () => {
  const items = [item({ id: 2, type: 'Task', state: 'New', stateCategory: 'Proposed', changedDate: '2025-01-01T00:00:00Z' })];
  const { items: result } = computeImpediments(items, CONVENTION, () => [], TODAY);
  assert.strictEqual(result.length, 0);
});

test('a healthy item touched today does not appear; a stale in-progress item does', () => {
  const items = [
    item({ id: 3, type: 'Task', state: 'Active', stateCategory: 'InProgress', changedDate: TODAY }),
    item({ id: 4, type: 'Task', state: 'Active', stateCategory: 'InProgress', changedDate: '2026-01-01T00:00:00Z' }),
  ];
  const { items: result } = computeImpediments(items, CONVENTION, () => [], TODAY);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 4);
  assert.strictEqual(result[0].condition, 'stalled');
});

suite('US5 impediments: per-type conventions (FR-035b)');

test('a task at Blocked is not blocked when the Task rule names only OnHold', () => {
  const items = [item({ id: 5, type: 'Task', state: 'Blocked', stateCategory: 'Proposed' })];
  const { items: result } = computeImpediments(items, CONVENTION, () => [], TODAY);
  assert.strictEqual(result.length, 0);
});

test('a story at Blocked IS blocked — the User Story rule names it', () => {
  const items = [item({ id: 6, type: 'User Story', state: 'Blocked', stateCategory: 'Proposed' })];
  const { items: result } = computeImpediments(items, CONVENTION, () => [], TODAY);
  assert.strictEqual(result.length, 1);
});

suite('US5 impediments: an item meeting both conditions appears once (FR-037)');

test('a blocked AND stale item is reported once, as blocked', () => {
  const items = [item({ id: 7, type: 'Task', state: 'OnHold', stateCategory: 'Proposed', changedDate: '2025-01-01T00:00:00Z' })];
  const { items: result } = computeImpediments(items, CONVENTION, () => [], TODAY);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].condition, 'blocked');
});

suite('US5 impediments: staleness in working days (FR-038)');

test('a normal weekend does not flag healthy work', () => {
  // Friday 2026-01-30 to Sunday 2026-02-01 is a weekend gap — 0 working days.
  assert.strictEqual(workingDaysBetween('2026-01-30', '2026-02-01'), 0);
  const items = [item({ id: 8, type: 'Task', state: 'Active', stateCategory: 'InProgress', changedDate: '2026-01-30T00:00:00Z' })];
  const { items: result } = computeImpediments(items, CONVENTION, () => [], TODAY);
  assert.strictEqual(result.length, 0);
});

suite('US5 impediments: tag/field matches have no measurable duration (FR-035-ii)');

test('a tag match is blocked with durationKnown:false, since:null, workingDays:null', () => {
  const conv = { version: 1, byType: { Task: { states: [], tags: ['waiting-vendor'], field: null } } };
  const items = [item({ id: 9, type: 'Task', tags: ['waiting-vendor'], changedDate: '2025-01-01T00:00:00Z' })];
  const { items: result } = computeImpediments(items, conv, () => [], TODAY);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].matchedOn, 'tag');
  assert.strictEqual(result[0].durationKnown, false);
  assert.strictEqual(result[0].since, null);
  assert.strictEqual(result[0].workingDays, null);
});

test('a state+tag match uses matchedOn "state" with a real duration', () => {
  const conv = { version: 1, byType: { Task: { states: ['OnHold'], tags: ['waiting-vendor'], field: null } } };
  const items = [item({ id: 10, type: 'Task', state: 'OnHold', tags: ['waiting-vendor'] })];
  const revisions = [
    { changedDate: '2026-01-01T00:00:00Z', state: 'New' },
    { changedDate: '2026-01-05T00:00:00Z', state: 'OnHold' },
  ];
  const { items: result } = computeImpediments(items, conv, () => revisions, TODAY);
  assert.strictEqual(result[0].matchedOn, 'state');
  assert.strictEqual(result[0].durationKnown, true);
  assert.strictEqual(result[0].since, '2026-01-05T00:00:00Z');
});

suite('US5 impediments: completed/removed are exempt from both (data-model.md §7)');

test('a completed item in a blocked state is not reported', () => {
  const items = [item({ id: 11, type: 'Task', state: 'OnHold', stateCategory: 'Completed' })];
  const { items: result } = computeImpediments(items, CONVENTION, () => [], TODAY);
  assert.strictEqual(result.length, 0);
});

module.exports = run;

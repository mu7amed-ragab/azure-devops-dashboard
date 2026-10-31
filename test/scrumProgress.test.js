/** US2: sprint progress — counts reconcile, hours basis, stage fallback. */

const { suite, test, run, assert } = require('./harness');
const { computeSprintProgress } = require('../server/compute/sprintProgress');

function item(overrides) {
  return {
    id: 1,
    title: 'Story',
    type: 'User Story',
    state: 'Active',
    stateCategory: 'InProgress',
    assignedTo: null,
    url: 'https://x',
    ...overrides,
  };
}

/** A minimal sync stand-in: getFieldAt(id, field, date) reads from a fixed
 * Map<id, {completedWork, remainingWork}>, ignoring `date` (progress is
 * always "as of now" for this view). */
function fakeSync(hoursById) {
  return {
    getFieldAt(id, field) {
      const h = hoursById.get(id);
      if (!h) return null;
      return field === 'completedWork' ? h.completed : h.remaining;
    },
  };
}

suite('US2 sprint progress: counts reconcile (SC-003, FR-018)');

test('completed + inProgress + notStarted equals the number of stories listed', () => {
  const items = [
    item({ id: 1, stateCategory: 'Proposed' }),
    item({ id: 2, stateCategory: 'InProgress' }),
    item({ id: 3, stateCategory: 'Resolved' }),
    item({ id: 4, stateCategory: 'Completed' }),
    item({ id: 5, stateCategory: 'Removed' }),
  ];
  const sync = fakeSync(new Map());
  const { stories, counts } = computeSprintProgress(items, new Map(), sync, '2026-01-01');
  assert.strictEqual(stories.length, 4, 'Removed is excluded from the list entirely');
  assert.strictEqual(counts.completed + counts.inProgress + counts.notStarted, stories.length);
  assert.strictEqual(counts.notStarted, 1);
  assert.strictEqual(counts.inProgress, 2, 'InProgress AND Resolved both fold into inProgress (FR-018a)');
  assert.strictEqual(counts.completed, 1);
});

suite('US2 sprint progress: progress basis (FR-016, FR-016a, FR-017)');

test('hours basis uses the hours proportion, not a task-count average', () => {
  const items = [item({ id: 10, stateCategory: 'InProgress' })];
  const childrenMap = new Map([[10, [11, 12]]]);
  // Two children of very different sizes: one fully done at 1h, one barely
  // started at 1/19h — a task-count average would read 0.5.
  const sync = fakeSync(new Map([
    [11, { completed: 1, remaining: 0 }],
    [12, { completed: 1, remaining: 18 }],
  ]));
  const { stories } = computeSprintProgress(items, childrenMap, sync, '2026-01-01');
  assert.strictEqual(stories[0].progressBasis, 'hours');
  // completed = 1 + 1 = 2; remaining = 0 + 18 = 18; hours proportion = 2/20 = 0.1,
  // not the 0.5 a task-count average (one done task, one barely-started task) would give.
  assert.ok(Math.abs(stories[0].progress - 0.1) < 1e-9, `expected hours proportion 0.1, got ${stories[0].progress}`);
  assert.notStrictEqual(stories[0].progress, 0.5, 'must not be the task-count average');
});

test('no measurable hours anywhere falls back to the stage value', () => {
  const items = [item({ id: 20, stateCategory: 'InProgress' })];
  const sync = fakeSync(new Map());
  const { stories } = computeSprintProgress(items, new Map(), sync, '2026-01-01');
  assert.strictEqual(stories[0].progressBasis, 'stage');
  assert.strictEqual(stories[0].progress, 0.5, 'InProgress stage value from STAGE_PROGRESS_BY_CATEGORY');
});

test('stage values are exactly STAGE_PROGRESS_BY_CATEGORY, keyed on category', () => {
  const cases = [
    ['Proposed', 0],
    ['InProgress', 0.5],
    ['Resolved', 0.9],
    ['Completed', 1],
  ];
  for (const [category, expected] of cases) {
    const items = [item({ id: 30, stateCategory: category })];
    const { stories } = computeSprintProgress(items, new Map(), fakeSync(new Map()), '2026-01-01');
    assert.strictEqual(stories[0].progress, expected, `${category} -> ${expected}`);
  }
});

module.exports = run;

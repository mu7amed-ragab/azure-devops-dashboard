/**
 * US2 (005-search-history-sprint-placement): "a child in its own sprint is
 * visible in that sprint" — server/compute/crossSprint.js's promotion
 * predicate, and its wiring into server/sync.js#groupByIteration.
 *
 * The two guarantees most likely to break silently, per data-model.md §3 and
 * §6: a group's `hours` must be bit-identical whether or not promotions are
 * present (a promoted child's hours are already counted in its PARENT's own
 * group), and the same task must still appear nested under its story too,
 * unchanged, with `parentRef: null` there.
 */

const { suite, test, run, assert } = require('./harness');
const { shouldPromote, computeCrossSprintPromotions } = require('../server/compute/crossSprint');
const { groupByIteration } = require('../server/sync');

const SPRINT_A = 'Proj\\Sprint A';
const SPRINT_B = 'Proj\\Sprint B';
const UNRESOLVABLE = 'Proj\\UDC'; // outside the project's iteration tree, like the real one the docs describe
const TOO_OLD = 'Proj\\Sprint Old';

const iterationMap = new Map([
  [SPRINT_A, { name: 'Sprint A', startDate: '2026-02-01T00:00:00Z', finishDate: '2026-02-14T00:00:00Z' }],
  [SPRINT_B, { name: 'Sprint B', startDate: '2026-01-01T00:00:00Z', finishDate: '2026-01-14T00:00:00Z' }],
  // Present in the map but with no startDate — an unresolvable tree node
  // (e.g. the project root) never counts as "resolves to a real sprint".
  [TOO_OLD, { name: 'Sprint Old', startDate: '2020-01-01T00:00:00Z', finishDate: '2020-01-14T00:00:00Z' }],
]);

/** Matches server/sync.js's own MIN_ITERATION_YEAR = 2026 gate, combined
 * with "resolves to a real, dated sprint" — exactly what groupByIteration
 * passes into computeCrossSprintPromotions as isPromotableIteration. */
function isPromotableIteration(path) {
  const meta = iterationMap.get(path);
  if (!meta || !meta.startDate) return false;
  return new Date(meta.startDate).getFullYear() >= 2026;
}

let nextId = 1000;
function makeTask(overrides = {}) {
  nextId += 1;
  return {
    id: overrides.id ?? nextId,
    type: 'Task',
    title: overrides.title ?? `Task ${nextId}`,
    state: 'Active',
    stateCategory: 'InProgress',
    blocked: false,
    createdDate: null,
    changedDate: '2026-02-05T00:00:00Z',
    dueDate: null,
    iterationPath: overrides.iterationPath ?? null,
    assignedTo: 'Me',
    hours: overrides.hours ?? { estimated: 4, completed: 1, remaining: 3 },
    progressPct: 25,
    progressBasis: 'hours',
    pullRequests: [],
    parentId: overrides.parentId ?? null,
    parentRef: null,
  };
}

function makeStory(overrides = {}) {
  nextId += 1;
  return {
    id: overrides.id ?? nextId,
    title: overrides.title ?? `Story ${nextId}`,
    type: 'User Story',
    state: 'Active',
    stateCategory: 'InProgress',
    blocked: false,
    createdDate: null,
    changedDate: '2026-02-05T00:00:00Z',
    dueDate: null,
    iterationPath: overrides.iterationPath ?? null,
    repository: null,
    hours: overrides.hours ?? { estimated: 10, completed: 2, remaining: 8 },
    completionPct: 20,
    completionBasis: 'hours',
    tasks: overrides.tasks ?? [],
    pullRequests: [],
    hiddenTaskCount: 0,
    parentId: null,
  };
}

suite('shouldPromote / computeCrossSprintPromotions — the pure predicate');

test('a child in Sprint A under a parent in Sprint B is promoted', () => {
  const child = makeTask({ iterationPath: SPRINT_A });
  const story = makeStory({ iterationPath: SPRINT_B, tasks: [child] });
  assert.strictEqual(shouldPromote(child, story, isPromotableIteration), true);
  const promotions = computeCrossSprintPromotions([story], isPromotableIteration);
  assert.strictEqual(promotions.length, 1);
  assert.strictEqual(promotions[0].iterationPath, SPRINT_A);
  assert.strictEqual(promotions[0].item.id, child.id);
});

test('a child in the SAME sprint as its parent is not promoted', () => {
  const child = makeTask({ iterationPath: SPRINT_A });
  const story = makeStory({ iterationPath: SPRINT_A, tasks: [child] });
  assert.strictEqual(shouldPromote(child, story, isPromotableIteration), false);
  assert.strictEqual(computeCrossSprintPromotions([story], isPromotableIteration).length, 0);
});

test('a child with iterationPath: null is never promoted', () => {
  const child = makeTask({ iterationPath: null });
  const story = makeStory({ iterationPath: SPRINT_B, tasks: [child] });
  assert.strictEqual(shouldPromote(child, story, isPromotableIteration), false);
});

test('a parent with iterationPath: null is silent too (FR-020 — nothing to compare against)', () => {
  const child = makeTask({ iterationPath: SPRINT_A });
  const story = makeStory({ iterationPath: null, tasks: [child] });
  assert.strictEqual(shouldPromote(child, story, isPromotableIteration), false);
});

test('a child on an unresolvable path ("UDC") is not promoted', () => {
  const child = makeTask({ iterationPath: UNRESOLVABLE });
  const story = makeStory({ iterationPath: SPRINT_B, tasks: [child] });
  assert.strictEqual(shouldPromote(child, story, isPromotableIteration), false);
});

test('a child on a too-old sprint (before MIN_ITERATION_YEAR) is not promoted', () => {
  const child = makeTask({ iterationPath: TOO_OLD });
  const story = makeStory({ iterationPath: SPRINT_B, tasks: [child] });
  assert.strictEqual(shouldPromote(child, story, isPromotableIteration), false);
});

test('the promoted entry carries a parentRef built from the story, not a second ADO call', () => {
  const child = makeTask({ iterationPath: SPRINT_A, parentId: 555 });
  const story = makeStory({ id: 555, title: 'Login rate limiting', type: 'User Story', iterationPath: SPRINT_B, tasks: [child] });
  const [promo] = computeCrossSprintPromotions([story], isPromotableIteration);
  assert.deepStrictEqual(promo.item.parentRef, {
    id: 555,
    title: 'Login rate limiting',
    type: 'User Story',
    iterationPath: SPRINT_B,
  });
});

suite('groupByIteration wiring — the double-counting guard');

test('a promoted child appears as a top-level entry in ITS OWN sprint group', () => {
  const child = makeTask({ iterationPath: SPRINT_A, parentId: 1 });
  const story = makeStory({ id: 1, iterationPath: SPRINT_B, tasks: [child] });
  const { groups } = groupByIteration([story], [], iterationMap);

  const groupA = groups.find((g) => g.iterationPath === SPRINT_A);
  assert.ok(groupA, 'Sprint A got its own group even though no story/unparented item lives there directly');
  assert.strictEqual(groupA.crossSprintItems.length, 1);
  assert.strictEqual(groupA.crossSprintItems[0].id, child.id);
  assert.ok(groupA.crossSprintItems[0].parentRef, 'carries parentRef');
});

test('the SAME task also appears nested under its story, unchanged, with parentRef: null there', () => {
  const child = makeTask({ iterationPath: SPRINT_A, parentId: 1 });
  const story = makeStory({ id: 1, iterationPath: SPRINT_B, tasks: [child] });
  const { groups } = groupByIteration([story], [], iterationMap);

  const groupB = groups.find((g) => g.iterationPath === SPRINT_B);
  assert.strictEqual(groupB.stories[0].tasks.length, 1);
  assert.strictEqual(groupB.stories[0].tasks[0].id, child.id);
  assert.strictEqual(groupB.stories[0].tasks[0].parentRef, null);
});

test("a group's hours total is BIT-IDENTICAL with and without a promotion inside it", () => {
  const child = makeTask({ iterationPath: SPRINT_A, parentId: 1, hours: { estimated: 4, completed: 1, remaining: 3 } });
  const story = makeStory({ id: 1, iterationPath: SPRINT_B, hours: { estimated: 10, completed: 2, remaining: 8 }, tasks: [child] });

  const withPromotion = groupByIteration([story], [], iterationMap);
  const withoutPromotion = groupByIteration([makeStory({ id: 1, iterationPath: SPRINT_B, hours: { estimated: 10, completed: 2, remaining: 8 }, tasks: [] })], [], iterationMap);

  const groupBWith = withPromotion.groups.find((g) => g.iterationPath === SPRINT_B);
  const groupBWithout = withoutPromotion.groups.find((g) => g.iterationPath === SPRINT_B);
  assert.deepStrictEqual(groupBWith.hours, groupBWithout.hours, "the parent's own group hours must not change because one of its children got promoted");
  assert.deepStrictEqual(groupBWith.hours, { estimated: 10, completed: 2, remaining: 8 });

  // And Sprint A's own group — newly created purely to host the promotion —
  // contributes NOTHING to hours either (the child's hours already live in
  // Sprint B's story rollup above).
  const groupAWith = withPromotion.groups.find((g) => g.iterationPath === SPRINT_A);
  assert.deepStrictEqual(groupAWith.hours, { estimated: 0, completed: 0, remaining: 0 });
});

test('a matching-sprint child produces no crossSprintItems anywhere, and every group still has the empty array', () => {
  const child = makeTask({ iterationPath: SPRINT_B, parentId: 1 });
  const story = makeStory({ id: 1, iterationPath: SPRINT_B, tasks: [child] });
  const { groups } = groupByIteration([story], [], iterationMap);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].crossSprintItems, []);
});

test('an unresolvable child path produces no "No sprint" promotion', () => {
  const child = makeTask({ iterationPath: UNRESOLVABLE, parentId: 1 });
  const story = makeStory({ id: 1, iterationPath: SPRINT_B, tasks: [child] });
  const { groups } = groupByIteration([story], [], iterationMap);
  const noSprint = groups.find((g) => g.iterationPath === null);
  // The story itself resolves fine (Sprint B), so no "No sprint" bucket
  // exists at all here — proving the unresolvable CHILD path didn't conjure
  // one into being.
  assert.strictEqual(noSprint, undefined);
});

module.exports = run;

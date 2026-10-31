/** US6: sprint scope change — re-estimate deltas, additions/departures, net. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { computeScopeChange } = require('../server/compute/scopeChange');
const { Cache } = require('../server/cache');
const { SyncEngine } = require('../server/sync');
const { ScrumEngine } = require('../server/scrum');
const { buildScopeConfig } = require('../server/scopes');
const { createFakeClient, workItem } = require('./fixtures/fakeClient');
const { fetchWorkItemTypes } = require('../server/ado/workItemTypes');
const { fetchStatesForTypes } = require('../server/ado/states');
const { AGILE } = require('./fixtures/processes');

/** A minimal getFieldAt over a fixed per-story revision list — reproduces
 * SyncEngine.getFieldAt's "latest value at or before date" semantics. */
function fieldAtFactory(storiesById) {
  return (id, field, date) => {
    const revs = storiesById.get(id).revisions;
    let value = null;
    for (const r of revs) {
      if (r.changedDate && r.changedDate > date) break;
      if (field in r) value = r[field];
    }
    return value === undefined ? null : value;
  };
}

function story(id, title, revisions) {
  return { id, title, revisions, categoryAt: () => 'Removed' };
}

const SPRINT = { path: 'X\\Sprint 1', startDate: '2026-01-01', finishDate: '2026-01-14', status: 'past' };

suite('US6 scope change: re-estimate contributes the delta, not the new value (FR-042c, SC-013b)');

test('5 -> 8 contributes +3, never 8 whole', () => {
  const s = story(1, 'Story', [
    { changedDate: '2025-12-20', iterationPath: SPRINT.path, estimate: 5 },
    { changedDate: '2026-01-05', estimate: 8 },
  ]);
  const stories = new Map([[1, s]]);
  const result = computeScopeChange([s], SPRINT, fieldAtFactory(stories), '2026-02-01');
  const reest = result.events.find((e) => e.kind === 're-estimated');
  assert.strictEqual(reest.contribution, 3);
  assert.strictEqual(reest.previousEstimate, 5);
  assert.strictEqual(reest.newEstimate, 8);
});

test('8 -> 5 contributes -3', () => {
  const s = story(2, 'Story', [
    { changedDate: '2025-12-20', iterationPath: SPRINT.path, estimate: 8 },
    { changedDate: '2026-01-05', estimate: 5 },
  ]);
  const stories = new Map([[2, s]]);
  const result = computeScopeChange([s], SPRINT, fieldAtFactory(stories), '2026-02-01');
  const reest = result.events.find((e) => e.kind === 're-estimated');
  assert.strictEqual(reest.contribution, -3);
});

suite('US6 scope change: repeated re-estimates are cumulative (FR-042d)');

test('5 -> 8 -> 13 totals +8, not 21', () => {
  const s = story(3, 'Story', [
    { changedDate: '2025-12-20', iterationPath: SPRINT.path, estimate: 5 },
    { changedDate: '2026-01-04', estimate: 8 },
    { changedDate: '2026-01-08', estimate: 13 },
  ]);
  const stories = new Map([[3, s]]);
  const result = computeScopeChange([s], SPRINT, fieldAtFactory(stories), '2026-02-01');
  const total = result.events.filter((e) => e.kind === 're-estimated').reduce((sum, e) => sum + e.contribution, 0);
  assert.strictEqual(total, 8);
});

suite('US6 scope change: additions and departures (FR-042, FR-042a, FR-044)');

test('a story added after the sprint start is listed as added with its arrival date', () => {
  const s = story(4, 'Story', [
    { changedDate: '2025-12-01', iterationPath: 'X\\Backlog', estimate: 8 },
    { changedDate: '2026-01-06', iterationPath: SPRINT.path, estimate: 8 },
  ]);
  const stories = new Map([[4, s]]);
  const result = computeScopeChange([s], SPRINT, fieldAtFactory(stories), '2026-02-01');
  const added = result.events.find((e) => e.kind === 'added');
  assert.ok(added, 'expected an "added" event');
  assert.strictEqual(added.date, '2026-01-06');
  assert.strictEqual(added.contribution, 8);
});

test('a story present before the sprint start is commitment, not addition', () => {
  const s = story(5, 'Story', [{ changedDate: '2025-12-01', iterationPath: SPRINT.path, estimate: 8 }]);
  const stories = new Map([[5, s]]);
  const result = computeScopeChange([s], SPRINT, fieldAtFactory(stories), '2026-02-01');
  assert.strictEqual(result.events.some((e) => e.kind === 'added' && e.storyId === 5), false);
  assert.strictEqual(result.sizeAtStart, 8);
});

test('a departure distinguishes moved from removed', () => {
  const sMoved = { id: 6, title: 'Moved', revisions: [
    { changedDate: '2025-12-01', iterationPath: SPRINT.path, estimate: 4 },
    { changedDate: '2026-01-08', iterationPath: 'X\\Sprint 2', estimate: 4 },
  ], categoryAt: () => 'Proposed' };
  const sRemoved = { id: 7, title: 'Removed', revisions: [
    { changedDate: '2025-12-01', iterationPath: SPRINT.path, estimate: 3 },
    { changedDate: '2026-01-09', iterationPath: 'X\\Removed', estimate: 3 },
  ], categoryAt: () => 'Removed' };
  const stories = new Map([[6, sMoved], [7, sRemoved]]);
  const result = computeScopeChange([sMoved, sRemoved], SPRINT, fieldAtFactory(stories), '2026-02-01');
  const moved = result.events.find((e) => e.storyId === 6);
  const removed = result.events.find((e) => e.storyId === 7);
  assert.strictEqual(moved.departureKind, 'moved');
  assert.strictEqual(removed.departureKind, 'removed');
  assert.strictEqual(moved.contribution, -4);
});

suite('US6 scope change: a re-add must not erase re-estimates from an earlier membership stint (FR-042b, FR-042c)');

test('present at start, re-estimated, departs, then re-added: the pre-departure re-estimate still counts', () => {
  const s = story(9, 'Story', [
    { changedDate: '2025-12-01', iterationPath: SPRINT.path, estimate: 5 }, // in at baseline
    { changedDate: '2026-01-03', estimate: 8 }, // re-estimated 5 -> 8 while still in, BEFORE departure
    { changedDate: '2026-01-06', iterationPath: 'X\\Sprint 2', estimate: 8 }, // departs
    { changedDate: '2026-01-10', iterationPath: SPRINT.path, estimate: 8 }, // re-added
  ]);
  const stories = new Map([[9, s]]);
  const result = computeScopeChange([s], SPRINT, fieldAtFactory(stories), '2026-02-01');

  const reest = result.events.find((e) => e.kind === 're-estimated');
  assert.ok(reest, 'the 5 -> 8 re-estimate made before departure must still be reported');
  assert.strictEqual(reest.contribution, 3);

  const departed = result.events.find((e) => e.kind === 'departed');
  assert.strictEqual(departed.contribution, -8);
  const added = result.events.find((e) => e.kind === 'added');
  assert.strictEqual(added.contribution, 8);

  assert.strictEqual(result.sizeAtStart, 5);
  assert.strictEqual(result.net, 3, 're-estimate (+3) + departure (-8) + re-add (+8)');
  assert.strictEqual(result.sizeAtEnd, 8);
});

test('a re-estimate made WHILE DEPARTED is not double-counted when the story re-enters', () => {
  const s = story(10, 'Story', [
    { changedDate: '2025-12-01', iterationPath: SPRINT.path, estimate: 5 }, // in at baseline
    { changedDate: '2026-01-04', iterationPath: 'X\\Sprint 2', estimate: 5 }, // departs, unchanged
    { changedDate: '2026-01-06', estimate: 8 }, // re-estimated 5 -> 8 WHILE OUT — no event of its own
    { changedDate: '2026-01-10', iterationPath: SPRINT.path, estimate: 8 }, // re-added, carrying the already-updated 8
  ]);
  const stories = new Map([[10, s]]);
  const result = computeScopeChange([s], SPRINT, fieldAtFactory(stories), '2026-02-01');

  assert.strictEqual(
    result.events.some((e) => e.kind === 're-estimated'),
    false,
    'a change made while not a sprint member must not surface as its own re-estimated event'
  );
  const departed = result.events.find((e) => e.kind === 'departed');
  assert.strictEqual(departed.contribution, -5, 'departure is priced at the estimate AS OF departure, before the later change');
  const added = result.events.find((e) => e.kind === 'added');
  assert.strictEqual(added.contribution, 8, 're-entry is priced at the estimate AS OF re-entry, already reflecting the change made while out');

  assert.strictEqual(result.sizeAtStart, 5);
  assert.strictEqual(result.net, 3, 'departure (-5) + re-add (+8) already nets the true +3 change; no separate re-estimate event may add another +3 on top');
  assert.strictEqual(result.sizeAtEnd, 8);
});

suite('US6 scope change: net reconciles (SC-013a, FR-043)');

test('net = additions - departures + re-estimate differences, negative preserved', () => {
  const sDeparted = { id: 8, title: 'Departed', revisions: [
    { changedDate: '2025-12-01', iterationPath: SPRINT.path, estimate: 10 },
    { changedDate: '2026-01-08', iterationPath: 'X\\Sprint 2', estimate: 10 },
  ], categoryAt: () => 'Proposed' };
  const stories = new Map([[8, sDeparted]]);
  const result = computeScopeChange([sDeparted], SPRINT, fieldAtFactory(stories), '2026-02-01');
  assert.strictEqual(result.net, -10);
  assert.ok(result.net < 0, 'a negative net must not be clamped');
  assert.strictEqual(result.sizeAtEnd, result.sizeAtStart + result.net);
});

suite('US6 scope change: baseline is always the ADO sprint start date (FR-044a, FR-044b)');

test('baselineDate equals the sprint start, never inferred', () => {
  const result = computeScopeChange([], SPRINT, () => null, '2026-02-01');
  assert.strictEqual(result.baselineDate, SPRINT.startDate);
});

// --- A5: ScrumEngine.getScopeChange() reports undeterminable for a
// pre-index sprint, integration-level (server/scrum.js, not the pure
// compute module above) -------------------------------------------------

const PROJECT = { id: 'p1', name: 'ProjectSC' };

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-scopechange-${label}-`));
}

async function buildEngine({ sprintDefs, workItems = {} }) {
  const base = { org: 'test-org', pat: 'service-pat', apiVersion: '7.1', cacheDir: path.join(tmpRoot('sc'), '.cache'), dataDir: path.join(tmpRoot('sc'), 'data'), orgDataDir: path.join(tmpRoot('sc'), 'data', 'org'), defaultProject: null, ownerEmail: null, rolesWikiPage: '/Dashboard Roles Test', syncIntervalMs: 900000, prHistoryMonths: 12, maxProjectScopes: 8 };
  const config = buildScopeConfig(base, PROJECT, { readTokenIsService: true });
  const cache = new Cache(config.cacheDir);
  const engine = new SyncEngine({ ...config, pat: 'service-pat' }, cache, cache);
  const client = createFakeClient({ project: PROJECT.name, process: AGILE, workItems });
  engine.setClient(client);
  engine.types = await fetchWorkItemTypes(client);
  engine.states = await fetchStatesForTypes(client, engine.types.allTypes);
  engine.iterationMap = new Map(sprintDefs.map((d, i) => [d.path, { id: i + 1, name: d.path, path: d.path, startDate: d.start, finishDate: d.finish }]));
  return new ScrumEngine(config, cache, engine);
}

suite('US6 scope change: A5 — a pre-INDEX_START_DATE sprint reports undeterminable, never "stable"');

test('a sprint that started before the index existed reports determinable: false, not a confident 0 -> 0', async () => {
  const p1 = 'X\\Sprint 1';
  const scrum = await buildEngine({
    sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
    workItems: workItem({ id: 999, type: AGILE.categories[0].workItemTypes[0].name, state: 'Closed', teamProject: PROJECT.name }),
  });
  const result = await scrum.getScopeChange({ sprintPath: p1 });
  assert.strictEqual(result.determinable, false, 'the index has no real history this far back — absence of evidence, not evidence of stability');
  assert.strictEqual(result.sizeAtStart, 0);
  assert.strictEqual(result.sizeAtEnd, 0);
});

test('a sprint safely within the index range still computes normally', async () => {
  const p1 = 'X\\Sprint 1';
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine({
    sprintDefs: [{ path: p1, start: '2026-01-01', finish: '2026-01-14' }],
    workItems: workItem({ id: 998, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
  });
  scrum.sync.revisionIndex.set(998, [
    { rev: 1, changedDate: '2026-01-02', iterationPath: p1, estimate: 5, workItemType: requirementType, state: 'New' },
  ]);
  scrum.sync.revisionWatermark = '2026-02-01T00:00:00Z';
  const result = await scrum.getScopeChange({ sprintPath: p1 });
  assert.strictEqual(result.determinable, true);
});

suite('US6 scope change: A12 — a departed story\'s title is resolved, not left as a bare id');

test('a story that departed the sprint (and so is absent from the current sprint item set) still carries its real title on its departed event', async () => {
  const p1 = 'X\\Sprint 1';
  const p2 = 'X\\Sprint 2';
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const departedId = 997;
  const scrum = await buildEngine({
    sprintDefs: [{ path: p1, start: '2026-01-01', finish: '2026-01-14' }],
    workItems: workItem({ id: departedId, type: requirementType, state: 'Active', teamProject: PROJECT.name, title: 'The Departed Story', iterationPath: p2 }),
  });
  // Present at baseline in p1, departs to p2 partway through — its CURRENT
  // iterationPath (p2) means `_getSprintItems(p1)` never returns it, so
  // titleById has no entry for it going in.
  scrum.sync.revisionIndex.set(departedId, [
    { rev: 1, changedDate: '2026-01-01', iterationPath: p1, estimate: 5, workItemType: requirementType, state: 'Active' },
    { rev: 2, changedDate: '2026-01-08', iterationPath: p2, estimate: 5, workItemType: requirementType, state: 'Active' },
  ]);
  scrum.sync.revisionWatermark = '2026-02-01T00:00:00Z';

  const result = await scrum.getScopeChange({ sprintPath: p1 });
  const departedEvent = result.events.find((e) => e.storyId === departedId && e.kind === 'departed');
  assert.ok(departedEvent, 'expected a departed event for the story');
  assert.strictEqual(departedEvent.title, 'The Departed Story', 'the departed row must carry its real title, not a bare #id fallback');
});

module.exports = run;

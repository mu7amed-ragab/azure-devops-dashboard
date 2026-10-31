/**
 * 007-all-assigned-types — "show every work item assigned to me, whatever
 * its type". The dashboard used to fetch only requirement/task/bug items;
 * now the assigned-items query carries no type clause (and no state-name
 * clause — Removed items are dropped by CATEGORY after hydration), every type
 * the project has is discovered with its workflow and hours capability, and
 * results are placed by type category, never by name.
 *
 * What this suite guards, in the order the properties matter:
 *   - project isolation still holds with the type clause gone (Principle I)
 *   - nothing is decided by a type or state NAME (Principle II)
 *   - an hours write to a type without Completed Work is refused before any
 *     PATCH, after the ownership check (Principle III)
 *   - hours are counted exactly once (spec FR-008 / SC-004)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { Cache } = require('../server/cache');
const { SyncEngine } = require('../server/sync');
const { buildScopeConfig } = require('../server/scopes');
const { fetchWorkItemTypes, classifyByCategory, typeTracksHours } = require('../server/ado/workItemTypes');
const { statesFromEveryType } = require('../server/ado/states');
const { createFakeClient, workItem } = require('./fixtures/fakeClient');
const { AGILE, SCRUM, CUSTOM } = require('./fixtures/processes');
const workitems = require('../server/ado/workitems');
const { ForbiddenError } = require('../server/ado/writeback');

function flat(q) {
  return q.replace(/\s+/g, ' ');
}

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-alltypes-${label}-`));
}

function baseConfigIn(root) {
  return {
    org: 'test-org',
    pat: 'service-pat',
    apiVersion: '7.1',
    cacheDir: path.join(root, '.cache'),
    dataDir: path.join(root, 'data'),
    orgDataDir: path.join(root, 'data', 'org'),
    defaultProject: null,
    ownerEmail: null,
    rolesWikiPage: '/Dashboard Roles Test',
    syncIntervalMs: 900000,
    prHistoryMonths: 12,
    maxProjectScopes: 8,
  };
}

// ---------------------------------------------------------------------------
// A sync-pass harness. The shared fake client answers every WIQL POST with one
// fixed id list; a sync pass issues four different queries (two tree passes,
// the flat assigned-items query, Recently-updated), so this wraps it with a
// small WIQL *simulator* that honours the clauses that matter here — the
// project clause, the assignee, a `[System.WorkItemType] IN (...)` list and a
// literal `[System.State] <> 'Removed'` — so a test fails for the same reason
// the real query would have dropped an item.
// ---------------------------------------------------------------------------

const ME = { id: 'me-id', uniqueName: 'me@example.com', displayName: 'Me', isSelf: true };
const NOW = new Date().toISOString();

function assignedTo(fields, uniqueName) {
  const a = fields['System.AssignedTo'];
  return !!(a && a.uniqueName && a.uniqueName.toLowerCase() === uniqueName.toLowerCase());
}

function typeListIn(query, prefix) {
  const at = query.indexOf(`${prefix}[System.WorkItemType] IN (`);
  if (at < 0) return null;
  const start = query.indexOf('(', at + prefix.length) + 1;
  const list = query.slice(start, query.indexOf(')', start));
  return list.split(',').map((t) => t.trim().slice(1, -1));
}

function projectOf(query) {
  const m = /\[System\.TeamProject\] = '([^']*)'/.exec(query);
  return m ? m[1] : null;
}

function simulateWiql(query, items, { flatExclude = [], subject = ME } = {}) {
  const q = flat(query);
  const mine = (fields) => assignedTo(fields, subject.uniqueName);
  const project = projectOf(q);
  const rows = Object.entries(items).map(([id, item]) => ({ id: Number(id), f: item.fields }));
  const inProject = (r) => r.f['System.TeamProject'] === project;
  const literalRemoved = (prefix) => q.includes(`${prefix}[System.State] <> 'Removed'`);
  if (q.includes('FROM workItemLinks')) {
    const sourceTypes = typeListIn(q, '[Source].');
    const bySource = q.includes('[Source].[System.AssignedTo]');
    const relations = [];
    for (const child of rows) {
      const parent = rows.find((r) => r.id === child.f['System.Parent']);
      if (!parent || !inProject(parent) || !inProject(child)) continue;
      if (sourceTypes && !sourceTypes.includes(parent.f['System.WorkItemType'])) continue;
      if (literalRemoved('[Source].') && parent.f['System.State'] === 'Removed') continue;
      if (!mine(bySource ? parent.f : child.f)) continue;
      relations.push({ target: { id: parent.id } }, { source: { id: parent.id }, target: { id: child.id } });
    }
    return { workItemRelations: relations };
  }
  const types = typeListIn(q, '');
  const recent = q.includes('@today');
  const ids = rows
    .filter(inProject)
    .filter((r) => mine(r.f))
    .filter((r) => !types || types.includes(r.f['System.WorkItemType']))
    .filter((r) => !literalRemoved('') || r.f['System.State'] !== 'Removed')
    .filter((r) => (recent ? !!r.f['System.ChangedDate'] : !flatExclude.includes(r.id)))
    .map((r) => r.id);
  return { workItems: ids.map((id) => ({ id })) };
}

function mineItem(spec) {
  return workItem({
    teamProject: 'ProjectA',
    assignedToId: ME.id,
    assignedToUniqueName: ME.uniqueName,
    assignedToDisplayName: ME.displayName,
    ...spec,
  });
}

/** A real SyncEngine + disk Cache on a tmp dir, driven by a fake client whose
 * WIQL answers are simulated. Discovery/iterations/the revision walk are
 * stubbed — they're not what this suite tests; types and states are
 * discovered for real through the fake client. */
function buildSync(proc, items, { project = 'ProjectA', revisions = {}, flatExclude = [], subject = ME } = {}) {
  const root = tmpRoot('sync');
  const config = buildScopeConfig(baseConfigIn(root), { id: `id-${project}`, name: project }, { readTokenIsService: true });
  const cache = new Cache(config.cacheDir);
  const engine = new SyncEngine({ ...config, pat: 'service-pat' }, cache, cache);
  const base = createFakeClient({ project, process: proc, workItems: items });
  const client = {
    ...base,
    async get(apiPath, options) {
      if (apiPath === '/git/pullrequests') return { value: [] };
      return base.get(apiPath, options);
    },
    async post(apiPath, body, options) {
      if (apiPath === '/wit/wiql') {
        base.wiqlQueries.push(body.query);
        return simulateWiql(body.query, items, { flatExclude, subject });
      }
      return base.post(apiPath, body, options);
    },
  };
  engine.setClient(client);
  engine.ensureDiscovery = async () => ({ blockedSignal: null });
  engine.ensureIterationMap = async () => new Map();
  engine.ensureRevisionIndex = async () => 0;
  engine.revisionIndex = new Map(Object.entries(revisions).map(([id, revs]) => [Number(id), revs]));
  return { engine, client: base };
}

function rev(n, completedWork, changedBy = ME.uniqueName) {
  return { rev: n, completedWork, changedDate: NOW, changedBy };
}

function unparentedIds(dashboard) {
  return dashboard.groups.flatMap((g) => g.unparentedItems).map((t) => t.id);
}
function storyIds(dashboard) {
  return dashboard.groups.flatMap((g) => g.stories).map((st) => st.id);
}
function breakdownIds(dashboard) {
  return Object.values(dashboard.timeline.breakdown || {}).flatMap((entries) => entries.map((e) => e.id));
}

suite('007 foundational: every type is discovered, with its workflow and hours capability');

test('AGILE: everyType carries Feature and Epic with states; tracksHours false for Feature, true for Task', async () => {
  const client = createFakeClient({ project: 'ProjectA', process: AGILE });
  const types = await fetchWorkItemTypes(client);
  assert.strictEqual(types.source, 'categories');
  assert.ok(types.everyType.Feature, 'Feature is discovered');
  assert.ok(types.everyType.Epic, 'Epic is discovered');
  assert.ok(types.everyType.Feature.states.some((s) => s.name === 'Closed' && s.category === 'Completed'));
  assert.strictEqual(types.everyType.Feature.tracksHours, false);
  assert.strictEqual(types.everyType.Task.tracksHours, true);
  // The three-family lists are unchanged — the tree query, Scrum and PR
  // attribution keep reading them.
  assert.deepStrictEqual(types.requirementTypes, ['User Story']);
  assert.deepStrictEqual(types.allTypes, ['User Story', 'Task', 'Bug']);
});

test('a type list without states falls back to the per-type states endpoint and still yields Feature', async () => {
  const client = createFakeClient({ project: 'ProjectA', process: AGILE, typesListWithoutStates: true });
  const types = await fetchWorkItemTypes(client);
  assert.strictEqual(types.everyType.Feature.states, null);
  assert.strictEqual(types.everyType.Feature.tracksHours, null, 'no fields list -> unknown, not false');
  assert.strictEqual(typeTracksHours('Feature', types), true, 'unknown is permissive');
  const states = await statesFromEveryType(client, types.everyType, types.allTypes);
  assert.ok(states.Feature && states.Feature.some((s) => s.name === 'Active'));
  assert.ok(client.calls.some((c) => c.apiPath === '/wit/workitemtypes/Feature/states'));
});

test('a type whose states cannot be read is dropped from the map, not the whole map', async () => {
  const client = createFakeClient({ project: 'ProjectA', process: AGILE, typesListWithoutStates: true });
  const states = await statesFromEveryType(client, { Spike: { states: null, tracksHours: null } }, ['Task']);
  assert.ok(!('Spike' in states), 'unreadable workflow -> no entry -> resolveWorkflow().known === false');
  assert.ok(states.Task, 'the readable type is still there');
});

test('classifyByCategory: requirement category -> story; bugs, tasks and every other type -> item', async () => {
  const agile = await fetchWorkItemTypes(createFakeClient({ project: 'A', process: AGILE }));
  const scrum = await fetchWorkItemTypes(createFakeClient({ project: 'S', process: SCRUM }));
  const custom = await fetchWorkItemTypes(createFakeClient({ project: 'C', process: CUSTOM }));
  assert.strictEqual(classifyByCategory('User Story', agile), 'story');
  assert.strictEqual(classifyByCategory('Product Backlog Item', scrum), 'story');
  assert.strictEqual(classifyByCategory('Delivery Item', custom), 'story');
  for (const t of ['Bug', 'Task', 'Feature', 'Epic']) assert.strictEqual(classifyByCategory(t, agile), 'item', t);
  assert.strictEqual(classifyByCategory('Impediment', custom), 'item');
  assert.strictEqual(classifyByCategory('Defect', custom), 'item');
});

test('every discovery call goes to the client\'s own project', async () => {
  const client = createFakeClient({ project: 'ProjectA', process: AGILE });
  const types = await fetchWorkItemTypes(client);
  await statesFromEveryType(client, types.everyType, types.allTypes);
  assert.ok(client.calls.length > 0);
  assert.ok(client.calls.every((c) => c.project === 'ProjectA'));
});

suite('007 US1: every assigned item, whatever its type');

test('queryAssignedItems: no type clause, no state clause, project clause kept, identity OR-group kept', async () => {
  const queries = [];
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async post(apiPath, body) {
      queries.push(body.query);
      return { workItems: [] };
    },
  };
  const person = {
    id: 'new-id',
    uniqueName: 'me@new.dev',
    identities: { all: [{ id: 'new-id', uniqueName: 'me@new.dev' }, { id: 'old-id', uniqueName: 'me@old.dev' }] },
  };
  await workitems.queryAssignedItems(client, person, {});
  const q = flat(queries[0]);
  assert.ok(!q.includes('[System.WorkItemType]'), 'no type clause (research.md R1)');
  assert.ok(!q.includes('[System.State]'), 'no state-name clause (research.md R13)');
  assert.match(q, /\[System\.TeamProject\] = 'ProjectA'/);
  assert.match(q, /AND \(\[System\.AssignedTo\] = 'me@new\.dev' OR \[System\.AssignedTo\] = 'me@old\.dev'\)/);
});

test('AGILE sync pass: open Feature is an item, childless story is a story, closed Feature is hidden-by-state', async () => {
  const items = {
    ...mineItem({ id: 101, type: 'Feature', state: 'Active' }),
    ...mineItem({ id: 102, type: 'Feature', state: 'Closed' }),
    ...mineItem({ id: 103, type: 'User Story', state: 'Active' }),
  };
  const { engine } = buildSync(AGILE, items);
  const dashboard = await engine._runSyncPass(ME);
  assert.deepStrictEqual(unparentedIds(dashboard), [101]);
  assert.deepStrictEqual(storyIds(dashboard), [103]);
  const story = dashboard.groups.flatMap((g) => g.stories).find((st) => st.id === 103);
  assert.deepStrictEqual(story.tasks, []);
  assert.strictEqual(dashboard.summary.hiddenByStateCount, 1, 'the closed Feature is counted as hidden by state');
});

test('custom process: an Impediment appears; one in a Removed-CATEGORY state ("Cut") is dropped and not counted', async () => {
  const items = {
    ...mineItem({ id: 201, type: 'Impediment', state: 'Open' }),
    ...mineItem({ id: 202, type: 'Impediment', state: 'Cut' }),
  };
  const { engine } = buildSync(CUSTOM, items);
  const dashboard = await engine._runSyncPass(ME);
  assert.deepStrictEqual(unparentedIds(dashboard), [201]);
  assert.strictEqual(dashboard.summary.hiddenByStateCount, 0, 'a Removed item is excluded, never "hidden by state"');
});

test("isolation: another project's Feature never reaches this project's payload, and every query names this project", async () => {
  const items = {
    ...mineItem({ id: 501, type: 'Feature', state: 'Active' }),
    ...mineItem({ id: 502, type: 'Feature', state: 'Active', teamProject: 'ProjectB' }),
  };
  const { engine, client } = buildSync(AGILE, items);
  const dashboard = await engine._runSyncPass(ME);
  assert.deepStrictEqual(unparentedIds(dashboard), [501]);
  assert.ok(client.wiqlQueries.length > 0);
  for (const q of client.wiqlQueries) {
    assert.match(q, /TeamProject\] = 'ProjectA'/);
    assert.ok(!q.includes('ProjectB'));
  }
});

test('SCRUM Recently-updated fallback classifies by category: PBI -> story, Feature -> task, closed Feature filtered', async () => {
  const items = {
    ...mineItem({ id: 601, type: 'Product Backlog Item', state: 'Committed', changedDate: NOW }),
    ...mineItem({ id: 602, type: 'Feature', state: 'Active', changedDate: NOW }),
    ...mineItem({ id: 603, type: 'Feature', state: 'Closed', changedDate: NOW }),
  };
  // Kept out of the flat query, so only the Recently-updated fallback reaches them.
  const { engine } = buildSync(SCRUM, items, { flatExclude: [601, 602, 603] });
  const dashboard = await engine._runSyncPass(ME);
  const byId = new Map(dashboard.recentItems.map((e) => [(e.story || e.task).id, e.kind]));
  assert.strictEqual(byId.get(601), 'story');
  assert.strictEqual(byId.get(602), 'task');
  assert.ok(!byId.has(603), 'a Completed-category Feature is not a visible recent item');
});

test('visibleStates covers the types present, not every type in the process', async () => {
  const items = { ...mineItem({ id: 701, type: 'Feature', state: 'Active' }) };
  const { engine } = buildSync(AGILE, items);
  const dashboard = await engine._runSyncPass(ME);
  assert.ok(dashboard.visibleStates.includes('Active'));
  assert.ok(!dashboard.visibleStates.includes('Funded'), 'Epic-only state, and no Epic is on this dashboard');
});

suite('007 US1: hours are counted exactly once (FR-008, SC-004)');

test('a newly included type contributes its own Completed Work once', async () => {
  const items = { ...mineItem({ id: 201, type: 'Impediment', state: 'Open', completed: 2 }) };
  const { engine } = buildSync(CUSTOM, items, { revisions: { 201: [rev(1, 0), rev(2, 2)] } });
  const dashboard = await engine._runSyncPass(ME);
  assert.strictEqual(dashboard.timeline.totalHours, 2);
  assert.deepStrictEqual(breakdownIds(dashboard), [201]);
});

test('a Feature with its own hours and a child Task: 3h + 4h = 7h, each counted once', async () => {
  const items = {
    ...mineItem({ id: 301, type: 'Feature', state: 'Active', completed: 3 }),
    ...mineItem({ id: 302, type: 'Task', state: 'Active', completed: 4, parentId: 301 }),
  };
  const { engine } = buildSync(AGILE, items, { revisions: { 301: [rev(1, 3)], 302: [rev(1, 4)] } });
  const dashboard = await engine._runSyncPass(ME);
  assert.strictEqual(dashboard.timeline.totalHours, 7);
  assert.deepStrictEqual(breakdownIds(dashboard).sort(), [301, 302]);
});

test('a Story/Task/Bug-only dashboard totals exactly what it did before (5h + 1h = 6h)', async () => {
  const items = {
    ...mineItem({ id: 401, type: 'User Story', state: 'Active' }),
    ...mineItem({ id: 402, type: 'Task', state: 'Active', completed: 5, parentId: 401 }),
    ...mineItem({ id: 403, type: 'Bug', state: 'Active', completed: 1 }),
  };
  const { engine } = buildSync(AGILE, items, { revisions: { 402: [rev(1, 5)], 403: [rev(1, 1)] } });
  const dashboard = await engine._runSyncPass(ME);
  assert.strictEqual(dashboard.timeline.totalHours, 6);
  assert.deepStrictEqual(storyIds(dashboard), [401]);
  assert.deepStrictEqual(unparentedIds(dashboard), [403]);
});

test('hours on a Removed-category item are not counted, as before', async () => {
  const items = {
    ...mineItem({ id: 201, type: 'Impediment', state: 'Open', completed: 1 }),
    ...mineItem({ id: 202, type: 'Impediment', state: 'Cut', completed: 5 }),
  };
  const { engine } = buildSync(CUSTOM, items, { revisions: { 201: [rev(1, 1)], 202: [rev(1, 5)] } });
  const dashboard = await engine._runSyncPass(ME);
  assert.strictEqual(dashboard.timeline.totalHours, 1);
});

suite('007 US2: act on newly visible items exactly where their type allows');

const logOneHour = (current) => ({ newCompleted: current.completed + 1, newRemaining: Math.max(0, current.remaining - 1) });

function writableSync(proc, items) {
  const built = buildSync(proc, items);
  built.engine._requestResyncFor = () => {};
  return built;
}

test('an hours write to a Feature (no Completed Work field) is refused with TYPE_NO_HOURS, and nothing is PATCHed', async () => {
  const items = { ...mineItem({ id: 801, type: 'Feature', state: 'Active' }) };
  const { engine, client } = writableSync(AGILE, items);
  await assert.rejects(engine.writeTaskHours(client, 801, logOneHour, ME), (err) => {
    assert.strictEqual(err.code, 'TYPE_NO_HOURS');
    assert.deepStrictEqual(err.details, { type: 'Feature' });
    return true;
  });
  assert.strictEqual(client.patches.length, 0);
});

test('the same write on an Impediment (tracks hours) lands with one PATCH', async () => {
  const items = { ...mineItem({ id: 802, type: 'Impediment', state: 'Open' }) };
  const { engine, client } = writableSync(CUSTOM, items);
  const result = await engine.writeTaskHours(client, 802, logOneHour, ME);
  assert.strictEqual(result.hours.completed, 1);
  assert.strictEqual(client.patches.length, 1);
});

test("ownership is still checked first: someone else's Feature is a 403, not TYPE_NO_HOURS", async () => {
  const items = { ...workItem({ id: 803, type: 'Feature', state: 'Active', teamProject: 'ProjectA', assignedToId: 'someone-else' }) };
  const { engine, client } = writableSync(AGILE, items);
  await assert.rejects(engine.writeTaskHours(client, 803, logOneHour, ME), (err) => {
    assert.ok(err instanceof ForbiddenError, `expected ForbiddenError, got ${err.code}`);
    return true;
  });
  assert.strictEqual(client.patches.length, 0);
});

test('a state write to a Feature succeeds — its workflow is discovered', async () => {
  const items = { ...mineItem({ id: 804, type: 'Feature', state: 'New' }) };
  const { engine, client } = writableSync(AGILE, items);
  const result = await engine.writeState(client, 804, 'Active', ME);
  assert.strictEqual(result.state, 'Active');
  assert.strictEqual(client.patches.length, 1);
});

test('a state write to a type whose workflow could not be read is refused, with no PATCH', async () => {
  const items = { ...mineItem({ id: 805, type: 'Spike', state: 'New' }) };
  const { engine, client } = writableSync(AGILE, items);
  await assert.rejects(engine.writeState(client, 805, 'Active', ME), /can't be validated/);
  assert.strictEqual(client.patches.length, 0);
});

test('hoursEditable: false on a Feature item, true on Task/Impediment; stories carry none', async () => {
  const agile = buildSync(AGILE, {
    ...mineItem({ id: 811, type: 'Feature', state: 'Active' }),
    ...mineItem({ id: 812, type: 'User Story', state: 'Active' }),
    ...mineItem({ id: 813, type: 'Task', state: 'Active', parentId: 812 }),
  });
  const a = await agile.engine._runSyncPass(ME);
  const items = a.groups.flatMap((g) => g.unparentedItems);
  const stories = a.groups.flatMap((g) => g.stories);
  assert.strictEqual(items.find((t) => t.id === 811).hoursEditable, false);
  assert.strictEqual(stories[0].tasks.find((t) => t.id === 813).hoursEditable, true);
  assert.ok(!('hoursEditable' in stories[0]), 'story hours are a rollup — no editor, no flag');

  const custom = buildSync(CUSTOM, { ...mineItem({ id: 814, type: 'Impediment', state: 'Open' }) });
  const c = await custom.engine._runSyncPass(ME);
  assert.strictEqual(c.groups.flatMap((g) => g.unparentedItems)[0].hoursEditable, true);
});

suite("007 US3: a teammate's view covers every type too, still read-only");

test("a teammate's Epic is on their dashboard, and the viewer's hours write to it is refused by ownership", async () => {
  const MATE = { id: 'mate-id', uniqueName: 'mate@example.com', displayName: 'Mate', isSelf: false };
  const items = {
    ...workItem({
      id: 901,
      type: 'Epic',
      state: 'Funded',
      teamProject: 'ProjectA',
      assignedToId: MATE.id,
      assignedToUniqueName: MATE.uniqueName,
    }),
  };
  const { engine, client } = buildSync(AGILE, items, { subject: MATE });
  engine._requestResyncFor = () => {};
  const dashboard = await engine._runSyncPass(MATE);
  assert.strictEqual(dashboard.isSelf, false);
  assert.ok(
    dashboard.groups.flatMap((g) => g.unparentedItems).some((t) => t.id === 901),
    'the Epic reaches the teammate dashboard'
  );
  // The route refuses any write for a non-self person first (index.js
  // writeHandler); underneath it, ownership is enforced on the item itself.
  await assert.rejects(engine.writeTaskHours(client, 901, logOneHour, ME), (err) => err instanceof ForbiddenError);
  assert.strictEqual(client.patches.length, 0);
});

module.exports = run;

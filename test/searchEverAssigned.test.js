/**
 * US1 (005-search-history-sprint-placement): "search reaches past
 * ownership" — GET /api/workitems/search, backed by
 * ado/workitems.js#queryEverAssigned and SyncEngine#searchEverAssigned.
 *
 * Two layers get exercised: queryEverAssigned's own WIQL text (project
 * clause, no type clause since 007, truncation, escaping) via the same
 * recordingClient pattern test/wiql.test.js already uses, and
 * SyncEngine#searchEverAssigned's own responsibilities — the 2-char floor
 * (no ADO call at all below it), the currently-assigned exclusion clause,
 * and the mandatory post-hydration System.TeamProject re-check (a
 * workitemsbatch response returns anything the token can see even through a
 * project-scoped URL — the same hazard ado/sprintItems.js's own filter
 * exists for).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { queryEverAssigned, everAssignedClause } = require('../server/ado/workitems');
const { applyTaskWrite, ForbiddenError } = require('../server/ado/writeback');
const { Cache } = require('../server/cache');
const { SyncEngine } = require('../server/sync');
const { buildScopeConfig } = require('../server/scopes');
const { createFakeClient, workItem } = require('./fixtures/fakeClient');
const { SCRUM, AGILE } = require('./fixtures/processes');

/** Mirrors test/wiql.test.js's recordingClient — captures the WIQL body text
 * queryEverAssigned sends, independent of SyncEngine/ensureTypes plumbing. */
function recordingClient(project, { wiqlResult = { workItems: [] } } = {}) {
  const queries = [];
  return {
    org: 'test-org',
    project,
    queries,
    async post(apiPath, body) {
      if (apiPath === '/wit/wiql') {
        queries.push(body.query);
        return wiqlResult;
      }
      throw new Error(`unexpected POST ${apiPath}`);
    },
  };
}

function flat(q) {
  return q.replace(/\s+/g, ' ');
}

suite('everAssignedClause / queryEverAssigned WIQL text');

test('carries the System.TeamProject clause', async () => {
  const client = recordingClient('ProjectA');
  await queryEverAssigned(client, 'me@example.com', { q: 'auth' });
  assert.strictEqual(client.queries.length, 1);
  assert.match(flat(client.queries[0]), /\[System\.TeamProject\] = 'ProjectA'/);
});

test('excludes the CURRENT assignment, on top of the EVER clause', async () => {
  const client = recordingClient('ProjectA');
  await queryEverAssigned(client, 'me@example.com', { q: 'auth' });
  const q = flat(client.queries[0]);
  assert.match(q, /\[System\.AssignedTo\] EVER 'me@example\.com'/);
  assert.match(q, /\[System\.AssignedTo\] <> 'me@example\.com'/);
});

test('every type: no type clause at all (007-all-assigned-types), TeamProject and EVER kept', async () => {
  const client = recordingClient('ScrumProject');
  await queryEverAssigned(client, 'me@example.com', { q: 'auth' });
  const q = flat(client.queries[0]);
  assert.ok(!q.includes('[System.WorkItemType]'), 'a formerly owned Feature is found like a formerly owned Task');
  assert.match(q, /\[System\.TeamProject\] = 'ScrumProject'/);
  assert.match(q, /\[System\.AssignedTo\] EVER 'me@example\.com'/);
  assert.ok(!q.includes('User Story'), 'no Agile type name anywhere in the query');
});

test('a numeric query adds an exact id match alongside title/tags', async () => {
  const client = recordingClient('ProjectA');
  await queryEverAssigned(client, 'me@example.com', { q: '123' });
  const q = flat(client.queries[0]);
  assert.match(q, /\[System\.Id\] = 123/);
  assert.match(q, /\[System\.Title\] CONTAINS '123'/);
});

test('a non-numeric query only matches title/tags, no id clause', async () => {
  const client = recordingClient('ProjectA');
  await queryEverAssigned(client, 'me@example.com', { q: 'auth flow' });
  const q = flat(client.queries[0]);
  assert.ok(!q.includes('[System.Id] ='));
  assert.match(q, /\[System\.Title\] CONTAINS 'auth flow'/);
  assert.match(q, /\[System\.Tags\] CONTAINS 'auth flow'/);
});

test("a quote in the query is escaped, not broken out of", async () => {
  const client = recordingClient('ProjectA');
  await queryEverAssigned(client, 'me@example.com', { q: "o'clock" });
  assert.match(flat(client.queries[0]), /CONTAINS 'o''clock'/);
});

test('excludes Removed items, like every other query in this file', async () => {
  const client = recordingClient('ProjectA');
  await queryEverAssigned(client, 'me@example.com', { q: 'auth' });
  assert.match(flat(client.queries[0]), /\[System\.State\] <> 'Removed'/);
});

test('applies no visible-state and no MIN_ITERATION_YEAR filter (research.md R5)', async () => {
  const client = recordingClient('ProjectA');
  await queryEverAssigned(client, 'me@example.com', { q: 'auth' });
  const q = flat(client.queries[0]);
  assert.ok(!q.includes('IterationPath'), 'an old sprint must still be findable');
});

test('more than the cap yields exactly `top` ids and truncated: true', async () => {
  const ids = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
  const client = recordingClient('ProjectA', { wiqlResult: { workItems: ids } });
  const { ids: resultIds, truncated } = await queryEverAssigned(client, 'me@example.com', {
    q: 'auth',
    top: 50,
  });
  assert.strictEqual(resultIds.length, 50);
  assert.strictEqual(truncated, true);
});

test('fewer than the cap is not reported truncated', async () => {
  const ids = [{ id: 1 }, { id: 2 }];
  const client = recordingClient('ProjectA', { wiqlResult: { workItems: ids } });
  const { ids: resultIds, truncated } = await queryEverAssigned(client, 'me@example.com', {
    q: 'auth',
    top: 50,
  });
  assert.strictEqual(resultIds.length, 2);
  assert.strictEqual(truncated, false);
});

suite('SyncEngine#searchEverAssigned');

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-search-${label}-`));
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

const PROJECT = { id: 'aaaaaaaa-1111-1111-1111-111111111111', name: 'ProjectA' };
const PERSON = { id: 'person-1', uniqueName: 'me@example.com', displayName: 'Me' };

function engineFor(process, { workItems = {}, wiqlIds = [] } = {}) {
  const root = tmpRoot('engine');
  const base = baseConfigIn(root);
  const config = buildScopeConfig(base, PROJECT, { readTokenIsService: true });
  const cache = new Cache(config.cacheDir);
  const engine = new SyncEngine({ ...config, pat: 'service-pat' }, cache);
  engine.setClient(createFakeClient({ project: PROJECT.name, process, workItems, wiqlIds }));
  return engine;
}

test('a query shorter than 2 characters makes no ADO call at all', async () => {
  const engine = engineFor(SCRUM);
  const result = await engine.searchEverAssigned(PERSON, 'a');
  assert.deepStrictEqual(result, { results: [], truncated: false, query: '' });
  assert.strictEqual(engine.client.calls.length, 0, 'no GET/POST reached the fake client');
});

test('an empty/whitespace-only query also short-circuits', async () => {
  const engine = engineFor(SCRUM);
  const result = await engine.searchEverAssigned(PERSON, '   ');
  assert.strictEqual(result.results.length, 0);
  assert.strictEqual(engine.client.calls.length, 0);
});

test('a workitemsbatch item from ANOTHER project is dropped before it becomes a result', async () => {
  const inProject = workItem({
    id: 101,
    type: 'Product Backlog Item',
    state: 'Active',
    title: 'Login rate limiting',
    teamProject: 'ProjectA',
    assignedToId: 'someone-else',
    assignedToDisplayName: 'Someone Else',
  });
  const otherProject = workItem({
    id: 202,
    type: 'Product Backlog Item',
    state: 'Active',
    title: 'Login rate limiting elsewhere',
    teamProject: 'ProjectB', // a different project — must never leak through
    assignedToId: 'someone-else',
  });
  const engine = engineFor(SCRUM, {
    workItems: { ...inProject, ...otherProject },
    wiqlIds: [101, 202],
  });

  const { results } = await engine.searchEverAssigned(PERSON, 'login');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].item.id, 101);
});

test('the WIQL sent by SyncEngine names no type at all, so no Agile name can leak into it', async () => {
  const items = workItem({
    id: 5,
    type: 'Product Backlog Item',
    state: 'Active',
    title: 'Some story',
    teamProject: 'ProjectA',
    assignedToId: 'someone-else',
  });
  const engine = engineFor(SCRUM, { workItems: items, wiqlIds: [5] });
  await engine.searchEverAssigned(PERSON, 'story');
  const q = flat(engine.client.wiqlQueries[0]);
  assert.ok(!q.includes('[System.WorkItemType]'));
  assert.ok(!q.includes('User Story'));
});

test('a formerly owned Feature comes back as a result (007-all-assigned-types)', async () => {
  const items = workItem({
    id: 77,
    type: 'Feature',
    state: 'Active',
    title: 'Checkout redesign',
    teamProject: 'ProjectA',
    assignedToId: 'someone-else',
  });
  const engine = engineFor(SCRUM, { workItems: items, wiqlIds: [77] });
  const { results } = await engine.searchEverAssigned(PERSON, 'checkout');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].item.id, 77);
  assert.strictEqual(results[0].item.type, 'Feature');
});

test('the current assignee is surfaced on the result', async () => {
  const items = workItem({
    id: 9,
    type: 'Task',
    state: 'Active',
    title: 'Now owned by someone else',
    teamProject: 'ProjectA',
    assignedToId: 'someone-else',
    assignedToDisplayName: 'Someone Else',
  });
  const engine = engineFor(SCRUM, { workItems: items, wiqlIds: [9] });
  const { results } = await engine.searchEverAssigned(PERSON, 'owned');
  assert.strictEqual(results[0].currentAssignee, 'Someone Else');
});

test('an unassigned item reports currentAssignee: null', async () => {
  const items = workItem({
    id: 11,
    type: 'Task',
    state: 'Active',
    title: 'Nobody has this now',
    teamProject: 'ProjectA',
    assignedToId: null,
  });
  const engine = engineFor(SCRUM, { workItems: items, wiqlIds: [11] });
  const { results } = await engine.searchEverAssigned(PERSON, 'nobody');
  assert.strictEqual(results[0].currentAssignee, null);
});

suite('a write to a past-owned item is refused (the real enforcement, not the UI)');

test('assertAssignedTo/applyTaskWrite rejects a write whose real AssignedTo differs from the caller', async () => {
  // A past-owned result's `item.id` is, by construction, assigned to someone
  // else NOW — searchEverAssigned's own WIQL excludes anything still
  // assigned to the caller. Writing to it must fail the exact same
  // ownership check every other write path uses (see writeback.test.js's
  // identically-shaped "ownership is still enforced" case); nothing in this
  // feature adds or needs a parallel enforcement of its own.
  const client = createFakeClient({
    project: 'ProjectA',
    workItems: workItem({ id: 42, type: 'Task', state: 'New', estimated: 8, teamProject: 'ProjectA', assignedToId: 'someone-else' }),
  });
  await assert.rejects(
    () => applyTaskWrite(client, 42, () => ({ newCompleted: 1, newRemaining: 7 }), PERSON.id, AGILE.states),
    ForbiddenError
  );
  assert.strictEqual(client.patches.length, 0);
});

module.exports = run;

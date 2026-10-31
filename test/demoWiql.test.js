/**
 * The demo organization evaluates WIQL for real. These cases pin the
 * properties that matter: it is organization-scoped like Azure DevOps (only
 * a [System.TeamProject] clause narrows it), EVER reads history, a date with
 * a time is rejected the way ADO rejects it, and every query this app's own
 * builders produce actually parses.
 */

const { suite, test, run, assert } = require('./harness');
const { evaluate } = require('../server/demo/wiql');
const workitems = require('../server/ado/workitems');
const { fetchPeople } = require('../server/ado/people');
const { detectBlockedSignal } = require('../server/ado/discovery');

const MONA = { displayName: 'منى أحمد', uniqueName: 'mona.ahmed@masar.dev', id: 'm' };
const MOHAMMED = { displayName: 'محمد العتيبي', uniqueName: 'mohammed.alotaibi@masar.dev', id: 'l' };
const TODAY = new Date(2026, 9, 29);

function item(id, project, fields, history = []) {
  const f = {
    'System.TeamProject': project,
    'System.WorkItemType': 'Task',
    'System.State': 'Active',
    'System.Title': `Item ${id}`,
    'System.Tags': '',
    'System.ChangedDate': '2026-10-28T10:00:00.000Z',
    ...fields,
  };
  const revisions = [...history.map((h, i) => ({ rev: i + 1, fields: { ...f, ...h } })), { rev: history.length + 1, fields: f }];
  return { id, fields: f, relations: [], revisions };
}

function fixture() {
  const story = item(1, 'Alpha', { 'System.WorkItemType': 'User Story', 'System.AssignedTo': MONA });
  const task = item(2, 'Alpha', { 'System.AssignedTo': MONA, 'System.Title': 'Checkout coupons', 'System.Tags': 'frontend; blocked' });
  const handed = item(3, 'Alpha', { 'System.AssignedTo': MOHAMMED, 'System.Title': 'Load test the checkout API' }, [{ 'System.AssignedTo': MONA }]);
  const other = item(4, 'Beta', { 'System.AssignedTo': MONA, 'System.ChangedDate': '2026-09-01T10:00:00.000Z' });
  const removed = item(5, 'Alpha', { 'System.AssignedTo': MONA, 'System.State': 'Removed' });
  story.relations.push({ rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/masar/_apis/wit/workItems/2' });
  return [story, task, handed, other, removed];
}

const ids = (r) => r.workItems.map((w) => w.id).sort((a, b) => a - b);

function recordingClient(project = 'Alpha') {
  const queries = [];
  return {
    org: 'masar',
    project,
    apiVersion: '7.1',
    queries,
    async post(apiPath, body) {
      if (apiPath === '/wit/wiql') {
        queries.push(body.query);
        return { workItems: [], workItemRelations: [] };
      }
      return { value: [] };
    },
    async get() {
      throw Object.assign(new Error('not here'), { status: 404 });
    },
    async request() {
      return { value: [] };
    },
  };
}

suite('demo WIQL evaluator');

test('without a [System.TeamProject] clause a query spans every project, like ADO', () => {
  const all = evaluate("SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = 'mona.ahmed@masar.dev'", { items: fixture(), today: TODAY });
  assert.deepStrictEqual(ids(all), [1, 2, 4, 5]);
  const scoped = evaluate(
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Alpha' AND [System.AssignedTo] = 'mona.ahmed@masar.dev'",
    { items: fixture(), today: TODAY }
  );
  assert.deepStrictEqual(ids(scoped), [1, 2, 5]);
});

test('IN, NOT IN, <>, <> empty, CONTAINS on title and tags, and Id equality', () => {
  const items = fixture();
  const q = (where) => ids(evaluate(`SELECT [System.Id] FROM WorkItems WHERE ${where}`, { items, today: TODAY }));
  assert.deepStrictEqual(q("[System.WorkItemType] IN ('User Story', 'Bug')"), [1]);
  assert.deepStrictEqual(q("[System.WorkItemType] NOT IN ('User Story')"), [2, 3, 4, 5]);
  assert.deepStrictEqual(q("[System.State] <> 'Removed' AND [System.TeamProject] = 'Alpha'"), [1, 2, 3]);
  assert.deepStrictEqual(q("[System.AssignedTo] <> ''"), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(q("[System.Title] CONTAINS 'checkout'"), [2, 3]);
  assert.deepStrictEqual(q("[System.Tags] CONTAINS 'blocked'"), [2]);
  assert.deepStrictEqual(q('[System.Id] = 3'), [3]);
  assert.deepStrictEqual(q('1 = 1 AND [System.Id] = 4'), [4]);
});

test('EVER matches an earlier assignee, not only the current one', () => {
  const r = evaluate(
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Alpha' AND [System.AssignedTo] EVER 'mona.ahmed@masar.dev' AND [System.AssignedTo] <> 'mona.ahmed@masar.dev'",
    { items: fixture(), today: TODAY }
  );
  assert.deepStrictEqual(ids(r), [3]);
});

test('@today-N compares by date', () => {
  const r = evaluate('SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= @today-7', { items: fixture(), today: TODAY });
  assert.deepStrictEqual(ids(r), [1, 2, 3, 5]);
});

test('a workItemLinks query returns a root row and a link row per matching pair', () => {
  const r = evaluate(
    "SELECT [System.Id] FROM workItemLinks WHERE ([Source].[System.WorkItemType] IN ('User Story')) AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') AND ([Target].[System.AssignedTo] = 'mona.ahmed@masar.dev') AND ([Source].[System.TeamProject] = 'Alpha')",
    { items: fixture(), today: TODAY }
  );
  assert.deepStrictEqual(r.workItemRelations, [
    { rel: null, source: null, target: { id: 1 } },
    { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 1 }, target: { id: 2 } },
  ]);
});

test('a date with a time is refused with the same message Azure DevOps gives', () => {
  assert.throws(
    () => evaluate("SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] > '2026-10-01T12:38:03.570Z'", { items: fixture(), today: TODAY }),
    (err) => err.status === 400 && /You cannot supply a time with the date/.test(err.message)
  );
});

test('unsupported syntax is a 400 naming the token', () => {
  assert.throws(
    () => evaluate("SELECT [System.Id] FROM WorkItems WHERE [System.AreaPath] UNDER 'Alpha'", { items: fixture(), today: TODAY }),
    (err) => err.status === 400 && /UNDER/.test(err.message)
  );
});

test("every WIQL query this app's builders produce parses and evaluates", async () => {
  const client = recordingClient();
  const person = { uniqueName: MONA.uniqueName, identities: { all: [MONA, { uniqueName: 'mona.ahmed@masar-legacy.dev' }] } };
  await workitems.queryAssignedItems(client, MONA.uniqueName);
  await workitems.queryAssignedItems(client, person, { since: '2026-10-01T08:00:00.000Z' });
  await workitems.queryAssignedTree(client, person, { since: '2026-10-01T08:00:00.000Z', storyTypes: ['User Story', 'Bug'] });
  await workitems.queryAssignedTree(client, MONA.uniqueName);
  await workitems.queryRecentlyUpdated(client, person, 30);
  await workitems.queryEverAssigned(client, person, { q: 'checkout' });
  await workitems.queryEverAssigned(client, MONA.uniqueName, { q: '42' });
  await fetchPeople(client);
  await detectBlockedSignal(client, { types: ['Task'], taskTypes: ['Task'] });
  assert.ok(client.queries.length >= 10, `captured ${client.queries.length} queries`);
  for (const query of client.queries) {
    const result = evaluate(query, { items: fixture(), today: TODAY });
    assert.ok(result.workItems || result.workItemRelations, `no result for: ${query}`);
  }
});

module.exports = run;

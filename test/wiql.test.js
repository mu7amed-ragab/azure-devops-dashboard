/**
 * The WIQL project clause — the biggest leak the scoping audit turned up.
 *
 * A WIQL query is ORGANIZATION-scoped. The project in the request URL
 * (`{org}/{project}/_apis/wit/wiql`) does not restrict the results; only an
 * explicit `[System.TeamProject]` clause does. Measured live against this org,
 * one identity, the same leaf query:
 *
 *   without the clause   ProjectA 356 items   ProjectC 356 items
 *   with the clause      ProjectA 349 items   ProjectC   0 items
 *
 * Two of the three work item queries had no clause, so every project's
 * dashboard was built from every project's work items. These tests assert on
 * the generated query text, because that is the only place the bug was visible
 * — the requests went to the right URL and returned a 200 the whole time.
 */

const { suite, test, run, assert } = require('./harness');
const {
  queryAssignedTree,
  queryAssignedItems,
  queryRecentlyUpdated,
  wiqlDate,
} = require('../server/ado/workitems');
const { detectBlockedSignal } = require('../server/ado/discovery');

/** Captures the WIQL bodies a query function sends. */
function recordingClient(project, { wiqlResult = {}, batchResult = { value: [] } } = {}) {
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
      if (apiPath === '/wit/workitemsbatch') return batchResult;
      throw new Error(`unexpected POST ${apiPath}`);
    },
    async get() {
      throw Object.assign(new Error('no states'), { status: 404 });
    },
  };
}

/** Normalizes whitespace so assertions read against the logical clause. */
function flat(q) {
  return q.replace(/\s+/g, ' ');
}

suite('every WIQL query names its project');

test('queryAssignedItems carries a System.TeamProject clause', async () => {
  const client = recordingClient('ProjectA');
  await queryAssignedItems(client, 'me@example.com', {});
  assert.strictEqual(client.queries.length, 1);
  assert.match(flat(client.queries[0]), /\[System\.TeamProject\] = 'ProjectA'/);
});

test('queryAssignedTree carries it on BOTH link sides', async () => {
  const client = recordingClient('ProjectA', { wiqlResult: { workItemRelations: [] } });
  await queryAssignedTree(client, 'me@example.com', { storyTypes: ['User Story'] });
  // Two queries (the Source-prefixed and Target-prefixed passes) — both must be
  // scoped, or the "stories containing a task of mine" half leaks on its own.
  assert.strictEqual(client.queries.length, 2);
  for (const q of client.queries) {
    assert.match(flat(q), /\[Source\]\.\[System\.TeamProject\] = 'ProjectA'/);
    assert.match(flat(q), /\[Target\]\.\[System\.TeamProject\] = 'ProjectA'/);
  }
});

test('queryRecentlyUpdated still carries it', async () => {
  const client = recordingClient('ProjectA');
  await queryRecentlyUpdated(client, 'me@example.com', 30);
  assert.match(flat(client.queries[0]), /\[System\.TeamProject\] = 'ProjectA'/);
});

test("the Blocked-signal sample query is scoped too", async () => {
  const client = recordingClient('ProjectA');
  await detectBlockedSignal(client, { types: ['Task'], taskTypes: ['Task'] });
  assert.ok(client.queries.length > 0, 'it reached the sampling step');
  assert.match(flat(client.queries[0]), /\[System\.TeamProject\] = 'ProjectA'/);
});

suite('the clause tracks the scope, and is injection-safe');

test('two projects generate two different queries', async () => {
  const a = recordingClient('ProjectA');
  const b = recordingClient('ProjectB');
  await queryAssignedItems(a, 'me@example.com', {});
  await queryAssignedItems(b, 'me@example.com', {});
  assert.notStrictEqual(a.queries[0], b.queries[0]);
  assert.match(flat(a.queries[0]), /'ProjectA'/);
  assert.ok(!flat(a.queries[0]).includes("'ProjectB'"));
});

test("a project name containing a quote is escaped, not broken out of", async () => {
  const client = recordingClient("Bob's Project");
  await queryAssignedItems(client, 'me@example.com', {});
  assert.match(flat(client.queries[0]), /\[System\.TeamProject\] = 'Bob''s Project'/);
});

test('a type name containing a quote is escaped too', async () => {
  // The tree query is the one that still carries a type list (the assigned-
  // items query has none since 007-all-assigned-types).
  const client = recordingClient('ProjectA', { wiqlResult: { workItemRelations: [] } });
  await queryAssignedTree(client, 'me@example.com', { storyTypes: ["Bob's Story"] });
  assert.match(flat(client.queries[0]), /IN \('Bob''s Story'\)/);
});

test('an assignee name containing a quote is escaped', async () => {
  const client = recordingClient('ProjectA');
  await queryAssignedItems(client, "o'brien@example.com", {});
  assert.match(flat(client.queries[0]), /= 'o''brien@example\.com'/);
});

suite('discovered types reach the query text');

test('a Scrum project queries for Product Backlog Item, not User Story', async () => {
  const client = recordingClient('ScrumProject', { wiqlResult: { workItemRelations: [] } });
  await queryAssignedTree(client, 'me@example.com', { storyTypes: ['Product Backlog Item', 'Bug'] });
  const q = flat(client.queries[0]);
  assert.match(q, /IN \('Product Backlog Item', 'Bug'\)/);
  assert.ok(!q.includes('User Story'), 'no Agile type name anywhere in the query');
});

test('a Basic project queries for Issue and has no Bug type', async () => {
  const client = recordingClient('BasicProject', { wiqlResult: { workItemRelations: [] } });
  await queryAssignedTree(client, 'me@example.com', { storyTypes: ['Issue'] });
  await queryAssignedItems(client, 'me@example.com', {});
  assert.match(flat(client.queries[0]), /IN \('Issue'\)/);
  // 007-all-assigned-types: the assigned-items query names no type at all.
  assert.ok(!flat(client.queries[2]).includes('[System.WorkItemType]'));
});

test('omitting the types falls back to Agile rather than an empty IN ()', async () => {
  // An empty type list would produce `IN ()` — a WIQL syntax error, or worse a
  // query matching nothing at all, which reads as "you have no work".
  const client = recordingClient('ProjectA', { wiqlResult: { workItemRelations: [] } });
  await queryAssignedTree(client, 'me@example.com', { storyTypes: [] });
  assert.match(flat(client.queries[0]), /IN \('User Story', 'Bug'\)/);
});

suite('the incremental `since` clause uses a date, because WIQL rejects a time');

test('wiqlDate strips the time component from an ISO timestamp', () => {
  // ADO answers a full timestamp with 400 "You cannot supply a time with the
  // date when running a query using date precision" — verified live, and it
  // failed identically before the project clauses were added, so this is a
  // long-standing bug rather than a regression.
  assert.strictEqual(wiqlDate('2026-07-28T12:38:03.570Z'), '2026-07-28');
  assert.strictEqual(wiqlDate('2026-07-28'), '2026-07-28', 'already date-only passes through');
});

test('the link query emits a date-only literal', async () => {
  const client = recordingClient('ProjectA', { wiqlResult: { workItemRelations: [] } });
  await queryAssignedTree(client, 'me@example.com', {
    since: '2026-07-28T12:38:03.570Z',
    storyTypes: ['User Story'],
  });
  for (const q of client.queries) {
    assert.match(flat(q), /\[System\.ChangedDate\] > '2026-07-28'/);
    assert.ok(!flat(q).includes('12:38'), 'no time component survives');
  }
});

test('the flat assigned-items query emits a date-only literal too', async () => {
  const client = recordingClient('ProjectA');
  await queryAssignedItems(client, 'me@example.com', {
    since: '2026-07-28T12:38:03.570Z',
  });
  assert.match(flat(client.queries[0]), /\[System\.ChangedDate\] > '2026-07-28'/);
  assert.ok(!flat(client.queries[0]).includes('T12:38'));
});

test('no `since` means no ChangedDate clause at all (the full pass)', async () => {
  const client = recordingClient('ProjectA');
  await queryAssignedItems(client, 'me@example.com', {});
  assert.ok(!flat(client.queries[0]).includes('ChangedDate'));
});

module.exports = run;

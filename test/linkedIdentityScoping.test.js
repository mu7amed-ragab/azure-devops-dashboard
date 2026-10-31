/**
 * 006-linked-identity-aliases (T013) — Constitution Principle I guard for
 * this feature: a multi-identity assignee condition MUST remain a single
 * parenthesised OR-group ANDed alongside `[System.TeamProject]`, never
 * something that can be read as `A AND B OR C` (research.md R2). This is
 * the offline half of that verification; R2-V1/V2/V3 in research.md still
 * need a live 200 against the real org before shipping (see
 * quickstart.md §2) — this suite only proves the TEXT SHAPE is right, the
 * same limit test/wiql.test.js's sibling suite already accepts for the
 * single-identity case.
 *
 * Also covers: a single-identity person's generated query text is
 * byte-identical to the pre-widening form (so nothing changes for the
 * common case), and the EVER / exclusion clauses in queryEverAssigned widen
 * symmetrically.
 */

const { suite, test, run, assert } = require('./harness');
const {
  queryAssignedTree,
  queryAssignedItems,
  queryRecentlyUpdated,
  queryEverAssigned,
  everAssignedClause,
  assigneeOrClause,
  assigneeNotAnyClause,
  everAssignedOrClause,
  identityNames,
} = require('../server/ado/workitems');

function recordingClient(project, { wiqlResult = {} } = {}) {
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

const PERSON = {
  id: 'new-id',
  uniqueName: 'alex.k@EXAMPLE.DEV',
  identities: {
    all: [
      { id: 'new-id', uniqueName: 'alex.k@EXAMPLE.DEV' },
      { id: 'old-id', uniqueName: 'alex.k@legacy-example.onmicrosoft.com' },
    ],
  },
};
const SINGLE = { id: 'new-id', uniqueName: 'alex.k@EXAMPLE.DEV', identities: { all: [{ id: 'new-id', uniqueName: 'alex.k@EXAMPLE.DEV' }] } };

suite('identityNames');

test('a plain string yields exactly one name (existing callers, unchanged)', () => {
  assert.deepStrictEqual(identityNames('me@example.com'), ['me@example.com']);
});

test('a single-identity person yields exactly one name', () => {
  assert.deepStrictEqual(identityNames(SINGLE), ['alex.k@EXAMPLE.DEV']);
});

test('a multi-identity person yields every identity in order, primary first', () => {
  assert.deepStrictEqual(identityNames(PERSON), ['alex.k@EXAMPLE.DEV', 'alex.k@legacy-example.onmicrosoft.com']);
});

suite('assigneeOrClause / assigneeNotAnyClause / everAssignedOrClause — text shape');

test('a single name produces the exact pre-widening `= \'x\'` text, no parentheses', () => {
  assert.strictEqual(assigneeOrClause('[System.AssignedTo]', ['a@x']), `[System.AssignedTo] = 'a@x'`);
});

test('two names produce ONE parenthesised OR-group', () => {
  const clause = assigneeOrClause('[System.AssignedTo]', ['a@x', 'b@y']);
  assert.strictEqual(clause, `([System.AssignedTo] = 'a@x' OR [System.AssignedTo] = 'b@y')`);
});

test('assigneeNotAnyClause ANDs a <> for every identity', () => {
  const clause = assigneeNotAnyClause('[System.AssignedTo]', ['a@x', 'b@y']);
  assert.strictEqual(clause, `[System.AssignedTo] <> 'a@x' AND [System.AssignedTo] <> 'b@y'`);
});

test('everAssignedOrClause with one name matches everAssignedClause byte-for-byte', () => {
  assert.strictEqual(everAssignedOrClause('[System.AssignedTo]', ['a@x']), everAssignedClause('a@x'));
});

test('everAssignedOrClause with two names is one parenthesised EVER OR-group', () => {
  const clause = everAssignedOrClause('[System.AssignedTo]', ['a@x', 'b@y']);
  assert.strictEqual(clause, `([System.AssignedTo] EVER 'a@x' OR [System.AssignedTo] EVER 'b@y')`);
});

suite('queryAssignedItems: widened assignee stays inside the surrounding AND, TeamProject intact');

test('single identity: query text is unchanged from the pre-widening form', async () => {
  const client = recordingClient('ProjectA');
  await queryAssignedItems(client, 'me@example.com', {});
  // Last clause since 007-all-assigned-types dropped the type/state clauses.
  assert.match(flat(client.queries[0]), /AND \[System\.AssignedTo\] = 'me@example\.com'(?: AND|$)/);
});

test('multi-identity: the OR-group is parenthesised and AND-ed alongside TeamProject, never OR-ed past it', async () => {
  const client = recordingClient('ProjectA');
  await queryAssignedItems(client, PERSON, {});
  const q = flat(client.queries[0]);
  assert.match(q, /\[System\.TeamProject\] = 'ProjectA'/);
  assert.match(
    q,
    /AND \(\[System\.AssignedTo\] = 'alex.k@EXAMPLE\.DEV' OR \[System\.AssignedTo\] = 'alex.k@legacy-example\.onmicrosoft\.com'\)(?: AND|$)/
  );
  // The property that actually matters: TeamProject and the assignee
  // OR-group are each their own top-level AND-ed unit — the OR never
  // escapes its own parentheses to combine with TeamProject directly.
  assert.ok(!/TeamProject.*OR/.test(q.replace(/\(.*?\)/g, '')), 'no bare OR reaching past TeamProject');
});

suite('queryAssignedTree: widened assignee on both link sides');

test('multi-identity: BOTH the Source-prefixed and Target-prefixed passes widen, and both keep TeamProject on both sides', async () => {
  const client = recordingClient('ProjectA', { wiqlResult: { workItemRelations: [] } });
  await queryAssignedTree(client, PERSON, { storyTypes: ['User Story'] });
  assert.strictEqual(client.queries.length, 2);
  for (const q of client.queries) {
    const flatQ = flat(q);
    assert.match(flatQ, /\[Source\]\.\[System\.TeamProject\] = 'ProjectA'/);
    assert.match(flatQ, /\[Target\]\.\[System\.TeamProject\] = 'ProjectA'/);
    assert.match(flatQ, /OR \[.*?\]\.\[System\.AssignedTo\] = 'alex.k@legacy-example\.onmicrosoft\.com'\)/);
  }
});

suite('queryRecentlyUpdated: widened assignee, TeamProject intact');

test('multi-identity assignee OR-group does not disturb TeamProject', async () => {
  const client = recordingClient('ProjectA');
  await queryRecentlyUpdated(client, PERSON, 30);
  const q = flat(client.queries[0]);
  assert.match(q, /\[System\.TeamProject\] = 'ProjectA'/);
  assert.match(q, /\(\[System\.AssignedTo\] = 'alex.k@EXAMPLE\.DEV' OR \[System\.AssignedTo\] = 'alex.k@legacy-example\.onmicrosoft\.com'\)/);
});

suite('queryEverAssigned: EVER widens, exclusion widens, item moved between identities is never "past-owned"');

test('single identity: unchanged text', async () => {
  const client = recordingClient('ProjectA');
  await queryEverAssigned(client, 'me@example.com', { q: 'foo' });
  const q = flat(client.queries[0]);
  assert.match(q, /\[System\.AssignedTo\] EVER 'me@example\.com'/);
  assert.match(q, /\[System\.AssignedTo\] <> 'me@example\.com'/);
});

test('multi-identity: EVER is an OR-group, exclusion is an AND-group of <>, TeamProject unaffected', async () => {
  const client = recordingClient('ProjectA');
  await queryEverAssigned(client, PERSON, { q: 'foo' });
  const q = flat(client.queries[0]);
  assert.match(q, /\[System\.TeamProject\] = 'ProjectA'/);
  assert.match(
    q,
    /\(\[System\.AssignedTo\] EVER 'alex.k@EXAMPLE\.DEV' OR \[System\.AssignedTo\] EVER 'alex.k@legacy-example\.onmicrosoft\.com'\)/
  );
  assert.match(
    q,
    /\[System\.AssignedTo\] <> 'alex.k@EXAMPLE\.DEV' AND \[System\.AssignedTo\] <> 'alex.k@legacy-example\.onmicrosoft\.com'/
  );
});

suite('cross-project isolation still holds under the widened shape');

test('the same widened query pointed at a different project names THAT project, not the first', async () => {
  const client = recordingClient('ProjectC');
  await queryAssignedItems(client, PERSON, {});
  const q = flat(client.queries[0]);
  assert.match(q, /\[System\.TeamProject\] = 'ProjectC'/);
  assert.ok(!/ProjectA/.test(q));
});

module.exports = run;

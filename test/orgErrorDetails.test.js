/**
 * Regression test for the TEAM_NOT_EMPTY / REPORTS_REASSIGN_REQUIRED
 * `details` contract, exercised end to end through the REAL production
 * code — not a local copy of it:
 *
 *   OrgStore.deleteTeam / OrgStore.updateMember (server/orgStore.js)
 *     -> throws the real codedValidationError
 *     -> server/errorBody.js (the same function server/index.js's routes
 *        call in their catch blocks)
 *     -> asserts the JSON response BODY actually carries `.details`
 *
 * A prior version of this test only asserted against a hand-copied
 * `codedValidationError` and never touched a response body, so it could not
 * catch (and did not catch) the routes dropping `err.details` before it
 * reached the client. This version fails if that regression reappears.
 */

const { suite, test, run, assert } = require('./harness');
const { OrgStore, codedValidationError } = require('../server/orgStore');
const { errorBody } = require('../server/errorBody');

/** Seeds an OrgStore's in-memory chart directly, bypassing the wiki I/O in
 * load()/reload() — deleteTeam's and updateMember's refusal paths only ever
 * read `this.store` before throwing, so this exercises the real refusal
 * logic without a network call or a fake AdoClient. */
function seededStore(overrides) {
  const store = new OrgStore('/dev/null');
  store.store = {
    version: 1,
    updatedAt: new Date().toISOString(),
    teams: [],
    members: [],
    blockedConvention: null,
    ...overrides,
  };
  return store;
}

suite('error details: codedValidationError factory');

test('TEAM_NOT_EMPTY error carries memberCount', () => {
  const err = codedValidationError('"My Team" still has 3 members.', 'TEAM_NOT_EMPTY', { memberCount: 3 });
  assert.strictEqual(err.code, 'TEAM_NOT_EMPTY');
  assert.strictEqual(err.details.memberCount, 3);
  assert(err.message.length > 0, 'message must not be empty');
});

test('REPORTS_REASSIGN_REQUIRED error carries reportCount and newManagerName', () => {
  const err = codedValidationError('Alice has 2 reports.', 'REPORTS_REASSIGN_REQUIRED', { reportCount: 2, newManagerName: 'Bob' });
  assert.strictEqual(err.code, 'REPORTS_REASSIGN_REQUIRED');
  assert.strictEqual(err.details.reportCount, 2);
  assert.strictEqual(err.details.newManagerName, 'Bob');
});

test('error without details (null) works correctly', () => {
  const err = codedValidationError('Something went wrong', 'GENERIC_ERROR', null);
  assert.strictEqual(err.code, 'GENERIC_ERROR');
  assert(!err.details, 'should not have a details object');
});

suite('error details: OrgStore.deleteTeam refusal (real method, not a copy)');

test('deleting a populated team without cascade throws TEAM_NOT_EMPTY with the real member count', async () => {
  const store = seededStore({
    teams: [{ id: 't1', name: 'Platform', managerMemberId: null }],
    members: [
      { id: 'm1', email: 'a@x.com', displayName: 'A', role: 'developer', teamId: 't1', parentId: null },
      { id: 'm2', email: 'b@x.com', displayName: 'B', role: 'developer', teamId: 't1', parentId: null },
      { id: 'm3', email: 'c@x.com', displayName: 'C', role: 'developer', teamId: 't1', parentId: null },
    ],
  });

  let thrown = null;
  try {
    await store.deleteTeam('t1', { cascade: false });
  } catch (err) {
    thrown = err;
  }

  assert(thrown, 'deleteTeam must throw when the team still has members and cascade is not set');
  assert.strictEqual(thrown.code, 'TEAM_NOT_EMPTY');
  assert.strictEqual(thrown.details.memberCount, 3);
  // The quote marks around the team name must be a matched curly pair
  // (“Platform”), not two closing quotes — see server/orgStore.js.
  assert(thrown.message.startsWith('“Platform”'), `expected a matched opening curly quote, got: ${thrown.message}`);
});

test('deleting an empty team does not throw the refusal (reaches the real save step)', async () => {
  const store = seededStore({ teams: [{ id: 't1', name: 'Empty', managerMemberId: null }], members: [] });
  // Only the refusal branch (TEAM_NOT_EMPTY) is under test here — stub the
  // wiki write so this doesn't need a real AdoClient, without touching the
  // branching logic in deleteTeam itself.
  store._save = async () => {};
  await store.deleteTeam('t1', { cascade: false }); // must not throw TEAM_NOT_EMPTY
  assert.strictEqual(store.store.teams.length, 0);
});

suite('error details: server/errorBody.js (the actual route-response shape)');

test('a TEAM_NOT_EMPTY refusal from the real OrgStore reaches the response body with details', async () => {
  const store = seededStore({
    teams: [{ id: 't1', name: 'Platform', managerMemberId: null }],
    members: [
      { id: 'm1', email: 'a@x.com', displayName: 'A', role: 'developer', teamId: 't1', parentId: null },
    ],
  });

  let body = null;
  try {
    await store.deleteTeam('t1', { cascade: false });
  } catch (err) {
    // This is the exact call server/index.js's DELETE /api/org/teams/:id
    // catch block makes. Before the fix it dropped err.details here.
    body = errorBody(err, err.code || 'VALIDATION');
  }

  assert(body, 'expected the delete to have thrown');
  assert.strictEqual(body.code, 'TEAM_NOT_EMPTY');
  assert(body.details, 'the response body must carry a details object');
  assert.strictEqual(body.details.memberCount, 1);
  assert(typeof body.error === 'string' && body.error.length > 0, 'error must stay a non-empty English string');
});

test('a REPORTS_REASSIGN_REQUIRED refusal from the real OrgStore reaches the response body with details', async () => {
  const store = seededStore({
    teams: [{ id: 't1', name: 'Platform', managerMemberId: null }],
    members: [
      { id: 'lead1', email: 'lead@x.com', displayName: 'Lead', role: 'lead', teamId: 't1', parentId: null },
      { id: 'dev1', email: 'dev@x.com', displayName: 'Dev', role: 'developer', teamId: 't1', parentId: 'lead1' },
    ],
  });

  let body = null;
  try {
    await store.updateMember('lead1', { role: 'developer' });
  } catch (err) {
    // This is the exact call server/index.js's PATCH /api/org/members/:id
    // catch block makes. Before the fix it dropped err.details here.
    body = errorBody(err, err.code || 'VALIDATION');
  }

  assert(body, 'expected the demotion to have thrown (lead1 has one report and reassignReports was not set)');
  assert.strictEqual(body.code, 'REPORTS_REASSIGN_REQUIRED');
  assert(body.details, 'the response body must carry a details object');
  assert.strictEqual(body.details.reportCount, 1);
});

test('a plain ADO_ERROR (no .details) does not grow a details key it never had', () => {
  const err = new Error('Azure DevOps timed out');
  const body = errorBody(err, 'ADO_ERROR');
  assert.strictEqual(body.code, 'ADO_ERROR');
  assert.strictEqual('details' in body, false, 'must not fabricate a details object for an error that never had one');
});

module.exports = run;

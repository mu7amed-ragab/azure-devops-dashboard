/**
 * Pull requests are the ONE org-wide view in an otherwise strictly
 * project-scoped app, and that is a deliberate product decision: a story ships
 * across repositories that don't all live in its own project, so a
 * project-scoped PR list is an incomplete — and unsearchable — answer to "what
 * shipped this story". See the module comment in server/ado/pullrequests.js.
 *
 * These tests pin down that it really is org-wide, that attribution can reach
 * the story regardless of which project it lives in, and that the pieces the UI
 * needs in order to LABEL a cross-project PR are actually present. The last part
 * is what keeps org-wide from being indistinguishable from a scoping bug.
 */

const { suite, test, run, assert } = require('./harness');
const { fetchPullRequests, normalizePr, filterPrHistoryWindow } = require('../server/ado/pullrequests');
const { attributePullRequests } = require('../server/ado/prAttribution');

const A = { id: 'aaaaaaaa-1111-1111-1111-111111111111', name: 'ProjectA' };
const B = { id: 'bbbbbbbb-2222-2222-2222-222222222222', name: 'ProjectB' };

/** A raw PR as ADO returns it, owned by `project`. */
function rawPr(id, project, extra = {}) {
  return {
    pullRequestId: id,
    title: `PR ${id}`,
    status: 'active',
    isDraft: false,
    creationDate: new Date().toISOString(),
    repository: { id: `repo-${project.name}`, name: `repo-${project.name}`, project: { id: project.id, name: project.name } },
    reviewers: [],
    ...extra,
  };
}

function normalized(id, project, extra) {
  return normalizePr(rawPr(id, project, extra), 'test-org');
}

suite('the PR search is organization-wide, on purpose');

test('fetchPullRequests asks the ORG endpoint, not the per-project one', async () => {
  const seen = [];
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get(apiPath, options) {
      seen.push({ apiPath, org: options && options.org });
      return { value: [] };
    },
  };
  await fetchPullRequests(client, 'person-1');
  // Two calls, not one: the fake returns nothing, which triggers the
  // empty-result retry below. Both must be org-scoped.
  assert.strictEqual(seen.length, 2);
  assert.ok(seen.every((c) => c.apiPath === '/git/pullrequests'));
  assert.ok(seen.every((c) => c.org === true), 'every attempt uses the org-wide search');
  // `org: true` routes this to {org}/_apis/... — Azure DevOps also offers
  // {org}/{project}/_apis/..., and choosing the org form is the decision under
  // test. If this ever flips, the Pull Requests page silently stops finding
  // PRs that shipped the story from another project's repo.
});

test('paging keeps using the org endpoint', async () => {
  const page = Array.from({ length: 200 }, (_, i) => rawPr(i + 1, A));
  let call = 0;
  const orgFlags = [];
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get(apiPath, options) {
      orgFlags.push(options && options.org);
      call += 1;
      return { value: call === 1 ? page : [rawPr(999, B)] };
    },
  };
  const prs = await fetchPullRequests(client, 'person-1');
  assert.strictEqual(prs.length, 201);
  assert.deepStrictEqual(orgFlags, [true, true]);
});

test('PRs from several projects all survive — nothing filters them out', async () => {
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get() {
      return { value: [rawPr(1, A), rawPr(2, B), rawPr(3, A)] };
    },
  };
  const prs = await fetchPullRequests(client, 'person-1');
  assert.strictEqual(prs.length, 3, "project B's PR is kept, not dropped");
});

suite('an all-empty PR result is retried once');

test('an empty first response is retried, and the second answer wins', async () => {
  // The observed failure: a sync came back with zero PRs where the same endpoint,
  // token and identity returned 1268 moments later — and the empty result was
  // cached, leaving the page blank. One retry makes a transient empty response
  // survivable.
  let attempt = 0;
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get() {
      attempt += 1;
      return { value: attempt === 1 ? [] : [rawPr(1, A), rawPr(2, B)] };
    },
  };
  const prs = await fetchPullRequests(client, 'person-1');
  assert.strictEqual(attempt, 2, 'it tried again');
  assert.strictEqual(prs.length, 2, 'and used the non-empty answer');
});

test('a genuinely empty result is believed after the retry', async () => {
  let attempt = 0;
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get() {
      attempt += 1;
      return { value: [] };
    },
  };
  const prs = await fetchPullRequests(client, 'person-1');
  assert.strictEqual(attempt, 2, 'exactly one retry, not a loop');
  assert.deepStrictEqual(prs, [], 'someone with no PRs still gets an empty list');
});

test('a non-empty first response is never retried', async () => {
  let attempt = 0;
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get() {
      attempt += 1;
      return { value: [rawPr(1, A)] };
    },
  };
  await fetchPullRequests(client, 'person-1');
  assert.strictEqual(attempt, 1, 'the normal path costs nothing extra');
});

suite('006-linked-identity-aliases (T016, T019): fetchPullRequests over several identities');

test('an array of one identity id behaves exactly like a bare string (single-identity case, unchanged)', async () => {
  const seen = [];
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get(apiPath, options) {
      seen.push(options.query['searchCriteria.creatorId']);
      return { value: [rawPr(1, A)] };
    },
  };
  const asString = await fetchPullRequests(client, 'person-1');
  const asArray = await fetchPullRequests(client, ['person-1']);
  assert.deepStrictEqual(asString, asArray);
});

test('two identities: the result is the UNION by pullRequestId, no duplicate', async () => {
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get(apiPath, options) {
      const id = options.query['searchCriteria.creatorId'];
      if (id === 'new-id') return { value: [rawPr(1, A), rawPr(2, A)] };
      if (id === 'old-id') return { value: [rawPr(2, A), rawPr(3, B)] }; // PR 2 overlaps — must not duplicate
      throw new Error(`unexpected identity ${id}`);
    },
  };
  const prs = await fetchPullRequests(client, ['new-id', 'old-id']);
  assert.strictEqual(prs.length, 3, 'PR 2 counted once despite appearing under both identities');
  assert.deepStrictEqual(
    prs.map((p) => p.pullRequestId).sort(),
    [1, 2, 3]
  );
});

test('one identity is genuinely empty, the other is not — the union still has the other\'s PRs', async () => {
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get(apiPath, options) {
      const id = options.query['searchCriteria.creatorId'];
      // 'old-id' has truly never created a PR: BOTH attempts (initial +
      // retry) return empty, and that must be believed rather than dropping
      // 'new-id's real result.
      if (id === 'old-id') return { value: [] };
      if (id === 'new-id') return { value: [rawPr(1, A)] };
      throw new Error(`unexpected identity ${id}`);
    },
  };
  const prs = await fetchPullRequests(client, ['new-id', 'old-id']);
  assert.strictEqual(prs.length, 1);
});

test('a spurious empty response on ONE identity is retried and recovered, without racing the other identity\'s fetch', async () => {
  // The real incident this whole retry exists for (see the module comment),
  // reproduced for exactly one of several identities: its first attempt is
  // spuriously empty, its retry succeeds, and the other identity's PRs are
  // still present in the union either way — proving the retry is not raced
  // out by a parallel fetch of the second identity.
  const attempts = { 'flaky-id': 0 };
  const client = {
    org: 'test-org',
    project: 'ProjectA',
    async get(apiPath, options) {
      const id = options.query['searchCriteria.creatorId'];
      if (id === 'stable-id') return { value: [rawPr(9, A)] };
      attempts['flaky-id'] = (attempts['flaky-id'] || 0) + 1;
      return { value: attempts['flaky-id'] === 1 ? [] : [rawPr(1, A)] };
    },
  };
  const prs = await fetchPullRequests(client, ['stable-id', 'flaky-id']);
  assert.strictEqual(attempts['flaky-id'], 2, 'the flaky identity got its own retry');
  assert.strictEqual(prs.length, 2, "both the stable identity's PR and the recovered flaky one are present");
  assert.deepStrictEqual(
    prs.map((p) => p.pullRequestId).sort(),
    [1, 9]
  );
});

suite('every PR carries what the UI needs to label its project');

test('normalizePr records the project id and name off the PR itself', () => {
  const pr = normalized(1, B);
  assert.strictEqual(pr.projectId, B.id);
  assert.strictEqual(pr.projectName, 'ProjectB');
});

test('the deep link uses the PR\'s OWN project, not the session\'s', () => {
  // Getting this from the session's project would 404 every cross-project PR.
  const pr = normalized(42, B);
  assert.strictEqual(pr.url, 'https://dev.azure.com/test-org/ProjectB/_git/repo-ProjectB/pullrequest/42');
});

test('a PR whose repository ADO would not describe degrades to nulls, not a crash', () => {
  const orphan = normalizePr({ pullRequestId: 9, title: 'orphan', status: 'active', repository: null }, 'test-org');
  assert.strictEqual(orphan.projectId, null);
  assert.strictEqual(orphan.projectName, null);
  assert.strictEqual(orphan.url, null);
});

suite('the history window still applies, independently of project');

test('an old completed PR is windowed out wherever it lives', () => {
  const old = normalized(1, B, {
    status: 'completed',
    closedDate: new Date('2020-01-01').toISOString(),
    creationDate: new Date('2019-01-01').toISOString(),
  });
  const recent = normalized(2, A);
  assert.deepStrictEqual(filterPrHistoryWindow([old, recent], 12).map((p) => p.id), [2]);
});

test('an active PR is never windowed out, whatever its age or project', () => {
  const oldButActive = normalized(1, B, { creationDate: new Date('2019-01-01').toISOString() });
  assert.strictEqual(filterPrHistoryWindow([oldButActive], 12).length, 1);
});

suite('attribution reaches the story across projects');

/** A client whose work-item batch behaves the way ADO actually does: it reads
 * any work item the token can see, regardless of the project in the URL. */
function crossProjectClient(items) {
  return {
    org: 'test-org',
    project: 'ProjectA',
    apiVersion: '7.1',
    async request() {
      return { value: [] }; // no ADO-linked work items, no commits
    },
    async post(apiPath, body) {
      assert.strictEqual(apiPath, '/wit/workitemsbatch');
      const hits = (body.ids || []).filter((id) => items[id]);
      // The real API 404s the WHOLE batch on an id it can't read;
      // fetchBatchResilient bisects to isolate it. Emulate that.
      if (hits.length !== (body.ids || []).length) throw Object.assign(new Error('not found'), { status: 404 });
      return { value: hits.map((id) => items[id]) };
    },
  };
}

test('a PR in project B resolves to a story living in project A', async () => {
  // Verified against the live API: POST {org}/{project}/_apis/wit/workitemsbatch
  // returns a work item belonging to a DIFFERENT project. That is what makes an
  // org-wide PR list useful rather than merely broad — the PR still finds its
  // story. (An earlier version of this suite asserted the opposite, on the
  // strength of a fake client that enforced isolation ADO does not.)
  const client = crossProjectClient({
    123456: { id: 123456, fields: { 'System.WorkItemType': 'User Story', 'System.Title': 'A story in A', 'System.State': 'Active' } },
  });
  const prs = [{ id: 1, title: 'Fix 123456', status: 'completed', projectId: B.id, repositoryId: 'r' }];
  const result = await attributePullRequests(client, prs, null, null, { storyTypes: ['User Story', 'Bug'] });
  assert.strictEqual(result.get(1).story.id, 123456);
  assert.strictEqual(result.get(1).story.title, 'A story in A');
});

test('an id the token genuinely cannot read is dropped, not surfaced as a story', async () => {
  const client = crossProjectClient({
    123456: { id: 123456, fields: { 'System.WorkItemType': 'User Story', 'System.Title': 'Readable', 'System.State': 'Active' } },
  });
  const prs = [
    { id: 1, title: 'Fix 123456', status: 'completed', projectId: A.id, repositoryId: 'r' },
    { id: 2, title: 'Fix 987654', status: 'completed', projectId: A.id, repositoryId: 'r' },
  ];
  const result = await attributePullRequests(client, prs, null, null, { storyTypes: ['User Story', 'Bug'] });
  assert.strictEqual(result.get(1).story.id, 123456);
  assert.strictEqual(result.get(2).story, null, 'unreadable id resolves to nothing');
  assert.deepStrictEqual(result.get(2).linkedItems, [], 'and is not leaked as a linked item either');
});

test('a number that is a real work item but not a story becomes a linkedItem', async () => {
  const client = crossProjectClient({
    123456: { id: 123456, fields: { 'System.WorkItemType': 'Task', 'System.Title': 'A task', 'System.State': 'Active', 'System.Parent': null } },
  });
  const prs = [{ id: 1, title: 'Fix 123456', status: 'completed', projectId: A.id, repositoryId: 'r' }];
  const result = await attributePullRequests(client, prs, null, null, { storyTypes: ['User Story', 'Bug'] });
  assert.strictEqual(result.get(1).story, null);
  assert.deepStrictEqual(result.get(1).linkedItems.map((i) => i.id), [123456]);
});

test('story types still come from the signed-in project', async () => {
  // Org-wide PRs do NOT make attribution guess at types: what counts as a story
  // is the current project's process template (SyncEngine.ensureTypes).
  const client = crossProjectClient({
    111111: { id: 111111, fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.Title': 'A PBI', 'System.State': 'Committed' } },
  });
  const prs = [{ id: 1, title: 'Fix 111111', status: 'completed', projectId: A.id, repositoryId: 'r' }];

  const scrum = await attributePullRequests(client, prs, null, null, { storyTypes: ['Product Backlog Item', 'Bug'] });
  assert.strictEqual(scrum.get(1).story.type, 'Product Backlog Item');

  const agile = await attributePullRequests(client, prs, null, null, { storyTypes: ['User Story', 'Bug'] });
  assert.strictEqual(agile.get(1).story, null, 'a PBI is not a story on an Agile project');
});

module.exports = run;

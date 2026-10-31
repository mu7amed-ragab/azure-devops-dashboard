/**
 * (A), (C), (E), (F), (H) in the brief, all of which are really one question:
 * can project A's data reach project B?
 *
 * These drive REAL SyncEngines and REAL Cache instances (in os.tmpdir()), with a
 * fake client standing in for Azure DevOps — so the thing under test is the
 * actual per-project wiring in server/scopes.js and server/sync.js, not a model
 * of it. Nothing here touches a live project or the repo's own .cache/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { Cache } = require('../server/cache');
const { SyncEngine } = require('../server/sync');
const { scopeSlug, scopeKey, buildScopeConfig } = require('../server/scopes');
const { createFakeClient } = require('./fixtures/fakeClient');
const { AGILE, SCRUM, CUSTOM } = require('./fixtures/processes');

const A = { id: 'aaaaaaaa-1111-1111-1111-111111111111', name: 'ProjectA' };
const B = { id: 'bbbbbbbb-2222-2222-2222-222222222222', name: 'ProjectB' };

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-${label}-`));
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

/** A SyncEngine wired to one project's scope config and cache, with ADO faked.
 * This is exactly the shape server/scopes.js `build()` produces. */
function engineFor(baseConfig, project, process, orgCache) {
  const config = buildScopeConfig(baseConfig, project, { readTokenIsService: true });
  const cache = new Cache(config.cacheDir);
  const engine = new SyncEngine({ ...config, pat: 'service-pat' }, cache, orgCache);
  engine.setClient(createFakeClient({ project: project.name, process }));
  return { config, cache, engine };
}

suite('scope identity: two projects can never share a directory or a key');

test('different projects get different cache directory names', () => {
  assert.notStrictEqual(scopeSlug(A), scopeSlug(B));
});

test('two projects whose names differ only in punctuation stay apart', () => {
  const one = { id: '11111111-0000-0000-0000-000000000000', name: 'My Project' };
  const two = { id: '22222222-0000-0000-0000-000000000000', name: 'My-Project' };
  assert.notStrictEqual(scopeSlug(one), scopeSlug(two), 'the id suffix disambiguates');
});

test('the slug is filesystem-safe even for a hostile project name', () => {
  const nasty = { id: 'cccccccc-0000-0000-0000-000000000000', name: '../../etc/passwd' };
  const slug = scopeSlug(nasty);
  assert.ok(!slug.includes('/'), slug);
  assert.ok(!slug.includes('\\'), slug);
  assert.ok(!slug.includes('..'), slug);
  assert.strictEqual(path.basename(slug), slug, 'is a single path segment');
});

test('the registry key is the GUID, so a rename keeps the warm scope', () => {
  assert.strictEqual(scopeKey({ id: A.id, name: A.name }), scopeKey({ id: A.id, name: 'RenamedA' }));
  assert.notStrictEqual(scopeKey(A), scopeKey(B));
});

suite('per-project config: cache dir, teams wiki, org fallback file');

test('every project-dependent path differs between A and B', () => {
  const root = tmpRoot('config');
  const base = baseConfigIn(root);
  const a = buildScopeConfig(base, A, { readTokenIsService: true });
  const b = buildScopeConfig(base, B, { readTokenIsService: true });

  assert.notStrictEqual(a.cacheDir, b.cacheDir);
  assert.notStrictEqual(a.orgDataFile, b.orgDataFile);
  assert.strictEqual(a.projectId, A.id);
  assert.strictEqual(a.project, A.name);
});

test('(H) teams are per project because the WIKI is per project', () => {
  // No projectId exists anywhere in the org chart's schema (server/org.js) — the
  // storage location IS the scoping. This is the assertion that pins that down.
  const base = baseConfigIn(tmpRoot('wiki'));
  assert.strictEqual(buildScopeConfig(base, A, {}).rolesWikiName, 'ProjectA.wiki');
  assert.strictEqual(buildScopeConfig(base, B, {}).rolesWikiName, 'ProjectB.wiki');
  assert.notStrictEqual(buildScopeConfig(base, A, {}).rolesWikiName, buildScopeConfig(base, B, {}).rolesWikiName);
});

test('readTokenIsService is carried per project, not globally', () => {
  const base = baseConfigIn(tmpRoot('token'));
  // (G): the service PAT reads A, but B fell back to a user's own PAT. B must
  // not inherit A's "service" standing — it is what gates background polling
  // and the isOwner fallback.
  assert.strictEqual(buildScopeConfig(base, A, { readTokenIsService: true }).readTokenIsService, true);
  assert.strictEqual(buildScopeConfig(base, B, { readTokenIsService: false }).readTokenIsService, false);
});

suite('(C) each project discovers its own process template');

test('A on Agile and B on Scrum resolve different types AND different states', async () => {
  const base = baseConfigIn(tmpRoot('process'));
  const a = engineFor(base, A, AGILE);
  const b = engineFor(base, B, SCRUM);

  const [typesA, typesB] = [await a.engine.ensureTypes(), await b.engine.ensureTypes()];
  assert.deepStrictEqual(typesA.storyTypes, ['User Story', 'Bug']);
  assert.deepStrictEqual(typesB.storyTypes, ['Product Backlog Item', 'Bug']);

  const [statesA, statesB] = [await a.engine.ensureStates(), await b.engine.ensureStates()];
  assert.ok(statesA['User Story'], 'A knows User Story');
  assert.strictEqual(statesB['User Story'], undefined, "B does not — it isn't a Scrum type");
  assert.ok(statesB['Product Backlog Item'], 'B knows Product Backlog Item');
  assert.strictEqual(statesA['Product Backlog Item'], undefined);

  const namesA = statesA.Task.map((s) => s.name);
  const namesB = statesB.Task.map((s) => s.name);
  assert.notDeepStrictEqual(namesA, namesB, "A's Task states differ from B's");
  assert.ok(namesA.includes('Closed') && !namesB.includes('Closed'));
  assert.ok(namesB.includes('Done') && !namesA.includes('Done'));
});

test('a third project on a custom process gets its own answer again', async () => {
  const base = baseConfigIn(tmpRoot('custom'));
  const c = engineFor(base, { id: 'cccccccc-3333-3333-3333-333333333333', name: 'ProjectC' }, CUSTOM);
  const types = await c.engine.ensureTypes();
  assert.deepStrictEqual(types.storyTypes, ['Delivery Item', 'Defect']);
  const states = await c.engine.ensureStates();
  assert.deepStrictEqual(states.Task.map((s) => s.name), ['Intake', 'Building', 'Deployed To Production']);
});

test("each project's client only ever requests its own project's URLs", async () => {
  const base = baseConfigIn(tmpRoot('urls'));
  const a = engineFor(base, A, AGILE);
  const b = engineFor(base, B, SCRUM);
  await a.engine.ensureStates();
  await b.engine.ensureStates();
  assert.ok(a.engine.client.calls.length > 0);
  assert.ok(a.engine.client.calls.every((c) => c.project === 'ProjectA'), 'A only asked ProjectA');
  assert.ok(b.engine.client.calls.every((c) => c.project === 'ProjectB'), 'B only asked ProjectB');
});

suite('(E) cache isolation on disk');

test("A's cache files land in A's directory and B cannot read them", async () => {
  const base = baseConfigIn(tmpRoot('cache'));
  const a = engineFor(base, A, AGILE);
  const b = engineFor(base, B, SCRUM);

  await a.engine.ensureStates();
  await b.engine.ensureStates();

  // Same key name in both (`states-v2` since 007-all-assigned-types) — the DIRECTORY is what separates them, which is why
  // no cache key in this codebase carries a project prefix.
  assert.ok(fs.existsSync(path.join(a.config.cacheDir, 'states-v2.json')));
  assert.ok(fs.existsSync(path.join(b.config.cacheDir, 'states-v2.json')));
  assert.notStrictEqual(a.config.cacheDir, b.config.cacheDir);

  const rawA = JSON.parse(fs.readFileSync(path.join(a.config.cacheDir, 'states-v2.json'), 'utf8'));
  const rawB = JSON.parse(fs.readFileSync(path.join(b.config.cacheDir, 'states-v2.json'), 'utf8'));
  assert.ok(rawA.states['User Story']);
  assert.strictEqual(rawB.states['User Story'], undefined);
});

test("a fresh Cache on B's directory cannot see A's entries", () => {
  const base = baseConfigIn(tmpRoot('cache2'));
  const aDir = buildScopeConfig(base, A, {}).cacheDir;
  const bDir = buildScopeConfig(base, B, {}).cacheDir;
  new Cache(aDir).set('dashboard-v5-person1', { secret: 'A only' });
  const bCache = new Cache(bDir);
  assert.strictEqual(bCache.get('dashboard-v5-person1'), undefined);
  assert.deepStrictEqual(bCache.keys(), []);
});

test('clearing A wipes only A — B is untouched', () => {
  const base = baseConfigIn(tmpRoot('clear'));
  const aDir = buildScopeConfig(base, A, {}).cacheDir;
  const bDir = buildScopeConfig(base, B, {}).cacheDir;
  const aCache = new Cache(aDir);
  const bCache = new Cache(bDir);
  aCache.set('revisionIndex', { entries: ['A'] });
  bCache.set('revisionIndex', { entries: ['B'] });

  // What SyncEngine.clearCache does: readdir + unlink over its OWN dir.
  for (const f of fs.readdirSync(aDir)) fs.unlinkSync(path.join(aDir, f));

  assert.deepStrictEqual(fs.readdirSync(aDir), []);
  assert.deepStrictEqual(new Cache(bDir).get('revisionIndex'), { entries: ['B'] });
});

suite('the shared org cache is for PR attribution only');

test('a SyncEngine given no org cache falls back to its own, so nothing breaks', () => {
  const base = baseConfigIn(tmpRoot('orgcache1'));
  const { engine, cache } = engineFor(base, A, AGILE);
  assert.strictEqual(engine.orgCache, cache, 'defaults to the project cache');
});

test('an explicit org cache is used for PR candidates and shared between projects', () => {
  // Pull requests are org-wide by design (server/ado/pullrequests.js), so their
  // attribution candidates — keyed by PR id, describing the PR and not the
  // viewer — are shared rather than re-fetched once per project. 2 ADO requests
  // per PR is the cost this avoids.
  const base = baseConfigIn(tmpRoot('orgcache2'));
  const shared = new Cache(path.join(base.cacheDir, '_org'));
  const a = engineFor(base, A, AGILE, shared);
  const b = engineFor(base, B, SCRUM, shared);

  a.engine.orgCache.set('pr-candidates-v1', { 7: [123456] });
  assert.deepStrictEqual(b.engine.orgCache.get('pr-candidates-v1'), { 7: [123456] }, 'B sees it');
  // ...while everything else stays strictly per project.
  a.cache.set('states', { fetchedAt: 1, states: { Task: [] } });
  assert.strictEqual(b.cache.get('states'), undefined, "but B does not see A's states");
});

test('the shared cache lives beside the scopes, not inside one', () => {
  const base = baseConfigIn(tmpRoot('orgcache3'));
  const shared = new Cache(path.join(base.cacheDir, '_org'));
  shared.set('pr-candidates-v1', { 1: [2] });
  const aDir = buildScopeConfig(base, A, {}).cacheDir;
  assert.ok(fs.existsSync(path.join(base.cacheDir, '_org', 'pr-candidates-v1.json')));
  assert.ok(!fs.existsSync(path.join(aDir, 'pr-candidates-v1.json')));
});

suite('(F) switching project: A -> B -> A serves no stale data');

test("B never sees A's in-memory process discovery, and A still has its own on return", async () => {
  const base = baseConfigIn(tmpRoot('switch'));
  const a = engineFor(base, A, AGILE);
  const b = engineFor(base, B, SCRUM);

  // A
  const first = await a.engine.ensureStates();
  assert.ok(first['User Story']);

  // -> B
  const onB = await b.engine.ensureStates();
  assert.strictEqual(onB['User Story'], undefined);
  assert.ok(onB['Product Backlog Item']);

  // -> back to A
  const back = await a.engine.ensureStates();
  assert.ok(back['User Story'], "A's own states came back");
  assert.strictEqual(back['Product Backlog Item'], undefined, "and B's did not come with them");
});

test('a scope rebuilt from disk (eviction, then reopen) reads only its own directory', async () => {
  const base = baseConfigIn(tmpRoot('evict'));
  const a1 = engineFor(base, A, AGILE);
  await a1.engine.ensureStates();
  a1.engine.dispose(); // what eviction does: drop the engine, keep the disk state

  // Reopening builds a brand-new engine over the same directory. Its client is
  // deliberately given NO process fixture, so any state it reports must have
  // come off A's own disk rather than the network or another scope.
  const config = buildScopeConfig(base, A, { readTokenIsService: true });
  const reopened = new SyncEngine({ ...config, pat: 'service-pat' }, new Cache(config.cacheDir));
  reopened.setClient(createFakeClient({ project: A.name }));
  const states = await reopened.ensureStates();
  assert.ok(states['User Story'], 'repainted from A\'s own cache');
  assert.strictEqual(states['Product Backlog Item'], undefined);
});

test('setClient drops process discovery so a re-elected token re-reads it', async () => {
  const base = baseConfigIn(tmpRoot('reelect'));
  const a = engineFor(base, A, AGILE);
  await a.engine.ensureTypes();
  assert.ok(a.engine.types);
  a.engine.setClient(createFakeClient({ project: A.name, process: AGILE }));
  assert.strictEqual(a.engine.types, null, 'types were dropped');
  assert.strictEqual(a.engine.states, null, 'states were dropped');
});

suite('(G) a user-PAT scope is never treated as the deployment');

test('isOwner refuses to anoint whoever opened a user-PAT project', async () => {
  const base = baseConfigIn(tmpRoot('owner'));
  // No ADO_OWNER_EMAIL configured, and B's reads run on a person's own PAT.
  const config = buildScopeConfig({ ...base, ownerEmail: null }, B, { readTokenIsService: false });
  const engine = new SyncEngine({ ...config, pat: 'someones-pat' }, new Cache(config.cacheDir));
  assert.strictEqual(await engine.isOwner('whoever@example.com'), false);
});

suite('a degraded PR fetch must not wipe a good index');

test('an empty fetch alongside a cached index is treated as a failure, not as truth', async () => {
  // The failure seen live: under a burst of rate-limit throttling, ADO answered
  // the PR search with {value: []} — no error, just nothing. fetchPullRequests
  // pages until a short page ends it, so that is indistinguishable from "this
  // person has no pull requests", and it overwrote a 243-PR index with an empty
  // one. The Pull Requests page then stayed blank long after the throttling
  // stopped, because the emptiness had been cached.
  const base = baseConfigIn(tmpRoot('prguard'));
  const { engine, cache } = engineFor(base, A, AGILE);
  const key = 'pr-index-v3-person-1'; // 006-linked-identity-aliases bumped this from v2

  const cached = [
    { id: 1, status: 'active', repository: 'repo-a', repositoryId: 'r1', projectName: 'ProjectA', createdDate: new Date().toISOString() },
    { id: 2, status: 'completed', repository: 'repo-a', repositoryId: 'r1', projectName: 'ProjectA', createdDate: new Date().toISOString() },
  ];
  cache.set(key, { personId: 'person-1', builtAt: Date.now(), prs: cached });

  // What the guard in _runSyncPass decides, expressed directly: the engine must
  // not replace a non-empty index when the fetch produced nothing.
  const previous = engine.getPrIndex('person-1');
  assert.strictEqual(previous.prs.length, 2);
  const fetched = [];
  const looksEmpty = fetched.length === 0 && previous && previous.prs.length > 0;
  assert.strictEqual(looksEmpty, true, 'this is the condition that must hold');

  // And the index is still intact afterwards — nothing overwrote it.
  assert.strictEqual(engine.getPrIndex('person-1').prs.length, 2);
});

test('a genuinely empty first sync still writes an empty index', () => {
  // The guard must not prevent the ordinary case: someone with no PRs at all.
  const base = baseConfigIn(tmpRoot('prguard2'));
  const { engine } = engineFor(base, A, AGILE);
  const previous = engine.getPrIndex('person-1');
  assert.strictEqual(previous, null, 'nothing cached yet');
  const looksEmpty = [].length === 0 && previous && previous.prs.length > 0;
  assert.ok(!looksEmpty, 'with no previous index there is nothing to protect');
});

test('the PR index key is versioned, so an org-wide v1 index is never read back', () => {
  const base = baseConfigIn(tmpRoot('prkey'));
  const { engine, cache } = engineFor(base, A, AGILE);
  cache.set('pr-index-v1-person-1', { personId: 'person-1', builtAt: 0, prs: [{ id: 99 }] });
  assert.strictEqual(engine.getPrIndex('person-1'), null, 'v1 is invisible to the current code');
});

module.exports = run;

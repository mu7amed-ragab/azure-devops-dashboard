/**
 * T072a: the feature's only write path. Covers validation against the
 * project's real values, the ETag conflict, WIKI_MISSING, and per-project
 * isolation — the write itself goes through server/orgStore.js's existing
 * wiki-backed store, reused rather than duplicated (FR-035c-i, FR-006g).
 */

const { suite, test, run, assert } = require('./harness');
const { OrgStore } = require('../server/orgStore');
const { validateConvention, matchBlocked, missingConfigRefs } = require('../server/blockedConvention');

function fakeWikiClient({ wikiExists = true, pages = {}, project = 'P' } = {}) {
  let etagCounter = 0;
  return {
    org: 'org',
    project,
    apiVersion: '7.1',
    async get(apiPath) {
      if (apiPath === '/wiki/wikis') return { value: wikiExists ? [{ name: `${project}.wiki` }] : [] };
      throw new Error(`unhandled get ${apiPath}`);
    },
    async request(url, opts = {}) {
      const u = new URL(url);
      if (!u.pathname.includes('/_apis/wiki/wikis/')) throw new Error(`unhandled request ${url}`);
      const path = decodeURIComponent(u.searchParams.get('path'));
      if (opts.method === 'GET') {
        const page = pages[path];
        if (!page) {
          const err = new Error('not found');
          err.status = 404;
          throw err;
        }
        return { data: { content: page.content }, headers: { etag: page.etag }, status: 200 };
      }
      if (opts.method === 'PUT') {
        if (!wikiExists) {
          const err = new Error('not found');
          err.status = 404;
          throw err;
        }
        const existing = pages[path];
        const ifMatch = opts.headers && opts.headers['If-Match'];
        if (existing && ifMatch !== undefined && ifMatch !== existing.etag) {
          const err = new Error('conflict');
          err.status = 409;
          throw err;
        }
        etagCounter += 1;
        const newEtag = `etag${etagCounter}`;
        pages[path] = { content: opts.body.content, etag: newEtag };
        return { headers: { etag: newEtag }, status: 200 };
      }
      throw new Error(`unhandled method ${opts.method}`);
    },
  };
}

// statesByType mirrors ado/states.js's REAL shape (fetchStatesForTypes): an
// array of {name, category, color} objects, never plain strings — a fixture
// of bare strings here would hide the exact bug this suite exists to catch
// (validateConvention/missingConfigRefs comparing a state NAME against a
// list of STATE OBJECTS and always failing/always-missing).
function stateObj(name, category = 'Proposed') {
  return { name, category, color: null };
}

const OPTIONS = {
  types: ['User Story', 'Task'],
  statesByType: {
    'User Story': [stateObj('New'), stateObj('OnHold'), stateObj('Blocked'), stateObj('Closed', 'Completed')],
    Task: [stateObj('New'), stateObj('OnHold'), stateObj('Active', 'InProgress'), stateObj('Closed', 'Completed')],
  },
  tags: ['waiting-vendor'],
  fields: ['Microsoft.VSTS.CMMI.Blocked'],
};

const CONFIG = { rolesWikiName: 'P.wiki', rolesWikiPage: '/Dashboard Roles' };

suite('blocked convention: validation against real project values (FR-035c-iii)');

test('a convention naming only real states/tags/fields is accepted', () => {
  const convention = { version: 1, byType: { Task: { states: ['OnHold'], tags: [], field: null } } };
  const saved = validateConvention(convention, OPTIONS);
  assert.deepStrictEqual(saved.byType.Task.states, ['OnHold']);
});

test('a state the project does not have is rejected (400 territory)', () => {
  const convention = { version: 1, byType: { Task: { states: ['NotARealState'], tags: [], field: null } } };
  assert.throws(() => validateConvention(convention, OPTIONS));
});

test('a tag not seen in the project is rejected', () => {
  const convention = { version: 1, byType: { Task: { states: [], tags: ['made-up-tag'], field: null } } };
  assert.throws(() => validateConvention(convention, OPTIONS));
});

test('a field the project does not have is rejected', () => {
  const convention = { version: 1, byType: { Task: { states: [], tags: [], field: 'Not.A.Real.Field' } } };
  assert.throws(() => validateConvention(convention, OPTIONS));
});

suite('blocked convention: A14 — field matching is by EQUALITY against a configured value, never truthiness');

test('validateConvention rejects a field rule with no "means blocked" value configured', () => {
  const convention = { version: 1, byType: { Task: { states: [], tags: [], field: 'Microsoft.VSTS.CMMI.Blocked' } } };
  assert.throws(() => validateConvention(convention, OPTIONS), /means blocked/);
});

test('validateConvention accepts a field rule with a configured value', () => {
  const convention = { version: 1, byType: { Task: { states: [], tags: [], field: 'Microsoft.VSTS.CMMI.Blocked', fieldBlockedValue: 'Blocked' } } };
  const saved = validateConvention(convention, OPTIONS);
  assert.strictEqual(saved.byType.Task.fieldBlockedValue, 'Blocked');
});

test("a picklist field's OWN 'Not blocked' option does not match — only the configured 'Blocked' value does", () => {
  const convention = { version: 1, byType: { Task: { states: [], tags: [], field: 'Microsoft.VSTS.CMMI.Blocked', fieldBlockedValue: 'Blocked' } } };
  const notBlocked = matchBlocked({ type: 'Task', state: 'New', tags: [], blockedField: 'Not blocked' }, convention);
  assert.strictEqual(notBlocked.blocked, false, 'the field\'s own non-blocking option must never match by truthiness');
  const blocked = matchBlocked({ type: 'Task', state: 'New', tags: [], blockedField: 'Blocked' }, convention);
  assert.strictEqual(blocked.blocked, true);
});

test('a numeric 0/1 field matches only the configured value, not "anything non-zero-ish"', () => {
  const convention = { version: 1, byType: { Task: { states: [], tags: [], field: 'Custom.BlockedFlag', fieldBlockedValue: 1 } } };
  assert.strictEqual(matchBlocked({ type: 'Task', state: 'New', tags: [], blockedField: 0 }, convention).blocked, false, '0 (not blocked) must never match by truthiness/old-style comparison');
  assert.strictEqual(matchBlocked({ type: 'Task', state: 'New', tags: [], blockedField: 1 }, convention).blocked, true);
});

test('a convention saved before fieldBlockedValue existed is read as boolean true (no migration needed)', () => {
  const legacyConvention = { version: 1, byType: { Task: { states: [], tags: [], field: 'Microsoft.VSTS.CMMI.Blocked' } } }; // no fieldBlockedValue key at all
  assert.strictEqual(matchBlocked({ type: 'Task', state: 'New', tags: [], blockedField: true }, legacyConvention).blocked, true);
  assert.strictEqual(matchBlocked({ type: 'Task', state: 'New', tags: [], blockedField: false }, legacyConvention).blocked, false);
});

test('a save returns the value IT wrote, not a later concurrent save\'s value read back off the shared store', async () => {
  const client = fakeWikiClient();
  const store = new OrgStore('/tmp/f.json');
  await store.load(client, CONFIG);

  // Simulate call A's write reaching ADO only after call B has already
  // mutated the shared in-memory store's blockedConvention (e.g. two tabs,
  // or a double-click submit) — a slow `client.request` for A, unblocked
  // after B's synchronous prefix has already run.
  let releaseA;
  const gate = new Promise((resolve) => {
    releaseA = resolve;
  });
  const originalRequest = client.request.bind(client);
  let first = true;
  client.request = async (url, opts) => {
    if (first && opts.method === 'PUT') {
      first = false;
      await gate;
    }
    return originalRequest(url, opts);
  };

  const conventionA = { version: 1, byType: { Task: { states: ['OnHold'], tags: [], field: null } } };
  const conventionB = { version: 1, byType: { Task: { states: ['Blocked'], tags: [], field: null } } };

  const savePromiseA = store.saveBlockedConvention(conventionA); // starts, then blocks on the gate before its PUT
  store.store.blockedConvention = conventionB; // B's synchronous prefix runs and wins the race in memory
  releaseA();
  const resultA = await savePromiseA;

  assert.deepStrictEqual(resultA, conventionA, "A's own save must return what A itself wrote, not B's concurrent value");
});

suite('blocked convention: saved via the wiki-backed org store, ETag-guarded (T072a, FR-035c-i)');

test('saves, and a subsequent read sees it', async () => {
  const client = fakeWikiClient();
  const store = new OrgStore('/tmp/does-not-matter.json');
  await store.load(client, CONFIG);
  const convention = { version: 1, byType: { Task: { states: ['OnHold'], tags: [], field: null } } };
  await store.saveBlockedConvention(convention);
  assert.deepStrictEqual(store.getStore().blockedConvention, convention);
});

test('a concurrent edit surfaces as a conflict, never silently clobbered', async () => {
  // Seed an existing page so both stores' initial load captures a REAL
  // ETag to go stale — starting from "page doesn't exist yet" would let
  // both writers create it with no If-Match to compare at all.
  const pages = { '/Dashboard Roles': { content: '# Dashboard Org Chart\n\n```json\n{"version":1,"teams":[],"members":[]}\n```\n', etag: 'etag0' } };
  const storeA = new OrgStore('/tmp/a.json');
  const storeB = new OrgStore('/tmp/b.json');
  await storeA.load(fakeWikiClient({ pages }), CONFIG);
  await storeB.load(fakeWikiClient({ pages }), CONFIG);

  await storeA.saveBlockedConvention({ version: 1, byType: { Task: { states: ['OnHold'], tags: [], field: null } } });
  // storeB still holds the ETag from before A's write (etag0), which the
  // page no longer carries.
  let threw = null;
  try {
    await storeB.saveBlockedConvention({ version: 1, byType: { Task: { states: ['Blocked'], tags: [], field: null } } });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'the second, stale-ETag write must throw rather than clobber');
  assert.strictEqual(threw.code, 'CONFLICT');
});

test('a project with no wiki fails with WIKI_MISSING (422 territory)', async () => {
  const client = fakeWikiClient({ wikiExists: false });
  const store = new OrgStore('/tmp/c.json');
  await store.load(client, CONFIG);
  let threw = null;
  try {
    await store.saveBlockedConvention({ version: 1, byType: {} });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw);
  assert.strictEqual(threw.code, 'WIKI_MISSING');
});

test('a failed (non-conflict) save rolls back the in-memory convention rather than leaving the unpersisted value live', async () => {
  const client = fakeWikiClient({ wikiExists: false }); // every _save() fails WIKI_MISSING
  const store = new OrgStore('/tmp/d.json');
  await store.load(client, CONFIG);
  assert.strictEqual(store.getStore().blockedConvention, null, 'nothing configured yet');

  let threw = null;
  try {
    await store.saveBlockedConvention({ version: 1, byType: { Task: { states: ['OnHold'], tags: [], field: null } } });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'the save must still fail');
  assert.strictEqual(
    store.getStore().blockedConvention,
    null,
    'a failed persist must not leave the attempted convention visible to the next read'
  );
});

test('a 409 conflict during save reloads the store instead of rolling back onto it', async () => {
  const pages = { '/Dashboard Roles': { content: '# Dashboard Org Chart\n\n```json\n{"version":1,"teams":[],"members":[],"blockedConvention":{"version":1,"byType":{"Task":{"states":["Blocked"],"tags":[],"field":null}}}}\n```\n', etag: 'etag0' } };
  const storeA = new OrgStore('/tmp/e-a.json');
  const storeB = new OrgStore('/tmp/e-b.json');
  await storeA.load(fakeWikiClient({ pages }), CONFIG);
  await storeB.load(fakeWikiClient({ pages }), CONFIG);

  // A saves first, moving the page's real ETag away from what B is holding.
  await storeA.saveBlockedConvention({ version: 1, byType: { Task: { states: ['OnHold'], tags: [], field: null } } });

  let threw = null;
  try {
    await storeB.saveBlockedConvention({ version: 1, byType: { Task: { states: ['Blocked'], tags: [], field: null } } });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw);
  assert.strictEqual(threw.code, 'CONFLICT');
  // B's store must reflect what reload() actually fetched (A's save) — not
  // the pre-conflict value the (removed) rollback would have restored.
  assert.deepStrictEqual(storeB.getStore().blockedConvention.byType.Task.states, ['OnHold']);
});

suite('blocked convention: per-project isolation (FR-035c-i)');

test('a convention saved in project A is invisible in project B', async () => {
  const pagesA = {};
  const pagesB = {};
  const storeA = new OrgStore('/tmp/pa.json');
  const storeB = new OrgStore('/tmp/pb.json');
  await storeA.load(fakeWikiClient({ pages: pagesA, project: 'A' }), CONFIG);
  await storeB.load(fakeWikiClient({ pages: pagesB, project: 'B' }), CONFIG);

  await storeA.saveBlockedConvention({ version: 1, byType: { Task: { states: ['OnHold'], tags: [], field: null } } });
  assert.strictEqual(storeB.getStore().blockedConvention, null);
});

suite('blocked convention: read-only against Azure DevOps work items (FR-006, FR-006g)');

test('saving issues no /wit/ or /work/ write — only the wiki page write', async () => {
  const pages = {};
  const calls = [];
  const client = fakeWikiClient({ pages });
  const originalRequest = client.request.bind(client);
  client.request = async (url, opts) => {
    calls.push({ url, method: opts.method });
    return originalRequest(url, opts);
  };
  const store = new OrgStore('/tmp/ro.json');
  await store.load(client, CONFIG);
  await store.saveBlockedConvention({ version: 1, byType: { Task: { states: ['OnHold'], tags: [], field: null } } });
  assert.ok(calls.every((c) => !/\/wit\/|\/work\//.test(c.url)), 'no ADO work-item write was issued');
  assert.ok(calls.some((c) => c.method === 'PUT' && c.url.includes('/wiki/')), 'the wiki page write did happen');
});

suite('matchBlocked / missingConfigRefs: OR combination, missing refs surfaced (FR-035a, FR-035e)');

test('states, tags, and field combine as OR', () => {
  const convention = { version: 1, byType: { Task: { states: ['OnHold'], tags: ['waiting-vendor'], field: 'Custom.Blocked' } } };
  assert.strictEqual(matchBlocked({ type: 'Task', state: 'New', tags: ['waiting-vendor'], blockedField: null }, convention).blocked, true);
  assert.strictEqual(matchBlocked({ type: 'Task', state: 'New', tags: [], blockedField: true }, convention).blocked, true);
  assert.strictEqual(matchBlocked({ type: 'Task', state: 'New', tags: [], blockedField: null }, convention).blocked, false);
});

test('a configured name no longer in the project is reported rather than crashing', () => {
  const convention = { version: 1, byType: { Task: { states: ['Retired'], tags: [], field: null } } };
  const missing = missingConfigRefs(convention, OPTIONS);
  assert.ok(missing.some((m) => m.includes('Retired')));
});

module.exports = run;

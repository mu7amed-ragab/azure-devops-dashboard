/**
 * Regression for the code-review finding: every Scrum view except velocity
 * read the revision index (getFieldAt/getRevisionsFor/getIdsByType/
 * getIdsByIteration/getChildrenMap/getLoggedHoursInRange all go straight at
 * `sync.revisionIndex`) WITHOUT first awaiting sync.ensureRevisionIndex() —
 * only _computeVelocity did. On a cold/never-synced project (or right after
 * REVISION_INDEX_VERSION was bumped 2->3, which discards the cached index)
 * that meant getProgress/getUtilisation/getBurndown/getImpediments/
 * getScopeChange could run against a still-empty index and silently return
 * empty results, which then got cached for SHORT_TTL_MS.
 *
 * This stubs SyncEngine with a `sync` double whose index-backed accessors
 * throw unless ensureRevisionIndex() has already resolved — the exact
 * ordering bug, made loud instead of silently "empty".
 */

const { suite, test, run, assert } = require('./harness');
const { ScrumEngine } = require('../server/scrum');

function fakeCache() {
  const store = new Map();
  return {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
  };
}

function fakeClient() {
  return {
    async get(path) {
      if (path === '/wit/fields') return { value: [] };
      throw new Error(`unexpected client.get ${path}`);
    },
    async post() {
      throw new Error('unexpected client.post');
    },
    async request() {
      throw new Error('unexpected client.request');
    },
  };
}

/** A `sync` double whose revision-index-backed reads throw unless
 * ensureRevisionIndex() has resolved first — everything else is a plain
 * stub returning empty/neutral values, since this suite only cares about
 * call ORDER, not the numbers each view produces (those are covered by
 * scrumProgress/scrumBurndown/scrumImpediments/scrumScopeChange/
 * scrumCapacity's own suites). */
function fakeSync({ sprint }) {
  let indexBuilt = false;
  const guard = (name, value) => (...args) => {
    if (!indexBuilt) throw new Error(`${name} called before ensureRevisionIndex() resolved`);
    return typeof value === 'function' ? value(...args) : value;
  };

  return {
    client: fakeClient(),
    revisionWatermark: '2025-01-01T00:00:00Z',
    orgStore: { getStore: () => ({ members: [], blockedConvention: null }) },
    async ensureRoles() {},
    async ensureRevisionIndex() {
      indexBuilt = true;
    },
    async ensureTypes() {
      return { storyTypes: ['User Story'], allTypes: ['User Story', 'Task'] };
    },
    async ensureStates() {
      return { 'User Story': [], Task: [] };
    },
    async ensureEstimateField() {
      return null;
    },
    async getSprints() {
      return { sprints: [sprint], currentPath: sprint.path };
    },
    getIdsByType: guard('getIdsByType', []),
    getIdsByIteration: guard('getIdsByIteration', []),
    getChildrenMap: guard('getChildrenMap', new Map()),
    getFieldAt: guard('getFieldAt', null),
    getRevisionsFor: guard('getRevisionsFor', []),
    getLoggedHoursInRange: guard('getLoggedHoursInRange', new Map()),
    getContributorsFor: guard('getContributorsFor', new Set()),
  };
}

const SPRINT = { id: 'guid-1', path: 'Proj\\Sprint 1', name: 'Sprint 1', startDate: '2025-06-01T00:00:00Z', finishDate: '2025-06-14T23:59:59.999Z', status: 'current' };

suite('Scrum views: every view awaits ensureRevisionIndex() before reading the index');

test('getProgress does not touch the index before ensureRevisionIndex resolves', async () => {
  const engine = new ScrumEngine({ projectId: null }, fakeCache(), fakeSync({ sprint: SPRINT }));
  const result = await engine.getProgress({ sprintPath: SPRINT.path });
  assert.deepStrictEqual(result.counts, { completed: 0, inProgress: 0, notStarted: 0 });
});

test('getUtilisation does not touch the index before ensureRevisionIndex resolves', async () => {
  const engine = new ScrumEngine({ projectId: null }, fakeCache(), fakeSync({ sprint: SPRINT }));
  const result = await engine.getUtilisation({ sprintPath: SPRINT.path });
  assert.deepStrictEqual(result.members, []);
});

test('getBurndown does not touch the index before ensureRevisionIndex resolves', async () => {
  const engine = new ScrumEngine({ projectId: null }, fakeCache(), fakeSync({ sprint: SPRINT }));
  const result = await engine.getBurndown({ sprintPath: SPRINT.path });
  assert.strictEqual(result.tracked, false); // no ids -> nothing tracked, but must not have thrown
});

test('getImpediments does not touch the index before ensureRevisionIndex resolves', async () => {
  const engine = new ScrumEngine({ projectId: null }, fakeCache(), fakeSync({ sprint: SPRINT }));
  const result = await engine.getImpediments({ sprintPath: SPRINT.path });
  assert.deepStrictEqual(result.items, []);
});

test('getScopeChange does not touch the index before ensureRevisionIndex resolves', async () => {
  const engine = new ScrumEngine({ projectId: null }, fakeCache(), fakeSync({ sprint: SPRINT }));
  const result = await engine.getScopeChange({ sprintPath: SPRINT.path });
  assert.strictEqual(result.determinable, true);
});

module.exports = run;

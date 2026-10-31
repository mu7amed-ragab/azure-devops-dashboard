/**
 * Regression for the code-review finding: ScrumEngine.getImpediments built
 * its `missingConfigRefs` options with `fields: []` hardcoded (server/scrum.js),
 * instead of the project's real eligible fields (server/ado/discovery.js
 * fetchEligibleBlockedFields) — so a configured blocked FIELD was always
 * reported missing, even when it demonstrably still exists and is actively
 * matching items (see server/blockedConvention.js's matchBlocked, which
 * reads the real field correctly). The banner this drives is permanent
 * without this fix.
 */

const { suite, test, run, assert } = require('./harness');
const { ScrumEngine } = require('../server/scrum');

function fakeCache() {
  const store = new Map();
  return { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
}

function fakeClient({ fields = [] } = {}) {
  return {
    async get(path) {
      if (path === '/wit/fields') return { value: fields };
      throw new Error(`unexpected client.get ${path}`);
    },
    async post() {
      return { value: [] }; // /wit/workitemsbatch — no sprint item ids in this suite
    },
    async request() {
      throw new Error('unexpected client.request');
    },
  };
}

const SPRINT = { id: 'guid-1', path: 'Proj\\Sprint 1', name: 'Sprint 1', startDate: '2025-06-01T00:00:00Z', finishDate: '2025-06-14T23:59:59.999Z', status: 'current' };

function fakeSync({ client, convention }) {
  return {
    client,
    revisionWatermark: '2025-01-01T00:00:00Z',
    orgStore: { getStore: () => ({ members: [], blockedConvention: convention }) },
    async ensureRoles() {},
    async ensureRevisionIndex() {},
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
      return { sprints: [SPRINT], currentPath: SPRINT.path };
    },
    getIdsByIteration: () => [],
    getRevisionsFor: () => [],
  };
}

suite('ScrumEngine.getImpediments: missingConfigRefs is checked against the REAL discovered fields');

test('a configured field that still exists in the project is not reported missing', async () => {
  const convention = { version: 1, byType: { Task: { states: [], tags: [], field: 'Microsoft.VSTS.CMMI.Blocked' } } };
  const client = fakeClient({ fields: [{ referenceName: 'Microsoft.VSTS.CMMI.Blocked', type: 'boolean' }] });
  const engine = new ScrumEngine({ projectId: null }, fakeCache(), fakeSync({ client, convention }));
  const result = await engine.getImpediments({ sprintPath: SPRINT.path });
  assert.deepStrictEqual(result.missingConfigRefs, []);
});

test('a configured field genuinely no longer eligible is reported missing', async () => {
  const convention = { version: 1, byType: { Task: { states: [], tags: [], field: 'Retired.Field' } } };
  const client = fakeClient({ fields: [{ referenceName: 'Microsoft.VSTS.CMMI.Blocked', type: 'boolean' }] });
  const engine = new ScrumEngine({ projectId: null }, fakeCache(), fakeSync({ client, convention }));
  const result = await engine.getImpediments({ sprintPath: SPRINT.path });
  assert.ok(result.missingConfigRefs.some((m) => m.includes('Retired.Field')));
});

module.exports = run;

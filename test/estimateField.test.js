/**
 * server/ado/estimateField.js: discoverEstimateField must distinguish "every
 * requirement type was checked and none carries a candidate field" (a real
 * null, FR-013a's "velocity unavailable" case) from "the check itself
 * failed" (must throw, never silently answer null) — see the regression this
 * guards in test/syncRevisionIndexColdWalk.test.js, where sync.js used to
 * swallow this into a poisoned v3 index.
 */

const { suite, test, run, assert } = require('./harness');
const { discoverEstimateField } = require('../server/ado/estimateField');

function clientWith({ fieldsByType = {}, failingTypes = [] } = {}) {
  return {
    async get(apiPath) {
      const m = /^\/wit\/workitemtypes\/([^/]+)$/.exec(apiPath);
      const type = decodeURIComponent(m[1]);
      if (failingTypes.includes(type)) throw Object.assign(new Error('network blip'), { status: 503 });
      return { name: type, fieldInstances: (fieldsByType[type] || []).map((referenceName) => ({ referenceName })) };
    },
  };
}

suite('discoverEstimateField: genuine absence vs. failed discovery');

test('returns the hit when a requirement type carries a candidate field', async () => {
  const client = clientWith({ fieldsByType: { 'User Story': ['Microsoft.VSTS.Scheduling.StoryPoints'] } });
  const result = await discoverEstimateField(client, ['User Story']);
  assert.deepStrictEqual(result, { field: 'Microsoft.VSTS.Scheduling.StoryPoints', label: 'Story Points' });
});

test('returns null when every type was successfully checked and none carry a candidate field', async () => {
  const client = clientWith({ fieldsByType: { 'User Story': ['System.Title'] } });
  const result = await discoverEstimateField(client, ['User Story']);
  assert.strictEqual(result, null);
});

test('throws, rather than returning null, when every type\'s check fails', async () => {
  const client = clientWith({ failingTypes: ['User Story', 'Bug'] });
  await assert.rejects(discoverEstimateField(client, ['User Story', 'Bug']));
});

test('a field found on a later type after an earlier type failed still counts as a real hit, not a failure', async () => {
  const client = clientWith({
    failingTypes: ['User Story'],
    fieldsByType: { Bug: ['Microsoft.VSTS.Scheduling.Effort'] },
  });
  const result = await discoverEstimateField(client, ['User Story', 'Bug']);
  assert.deepStrictEqual(result, { field: 'Microsoft.VSTS.Scheduling.Effort', label: 'Effort' });
});

module.exports = run;

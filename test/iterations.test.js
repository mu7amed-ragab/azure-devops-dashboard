/**
 * server/ado/iterations.js — flattening the classificationnodes/Iterations
 * tree. Regression for the code-review finding: capacity
 * (work/teamsettings/iterations/{iterationId}/capacities, US3) needs the
 * iteration's GUID (`identifier`), not the classificationnodes integer
 * `id` — the two are different identifiers for the same node, and passing
 * the wrong one was silently read as "no capacity recorded" by
 * ado/capacity.js's 400/404 fallback, making every team's utilisation show
 * "Not recorded" always.
 */

const { suite, test, run, assert } = require('./harness');
const { fetchIterationMap } = require('../server/ado/iterations');

function fakeClassificationClient(root) {
  return {
    async get(apiPath, options) {
      assert.strictEqual(apiPath, '/wit/classificationnodes/Iterations');
      assert.deepStrictEqual(options.query, { $depth: 6 });
      return root;
    },
  };
}

suite('iterations: fetchIterationMap exposes the iteration GUID as `id`, not the classificationnodes integer id');

test('a leaf node\'s `id` is its GUID `identifier`, not the numeric classificationnodes id', async () => {
  const root = {
    id: 1,
    identifier: 'aaaaaaaa-0000-0000-0000-000000000000',
    name: 'Proj',
    attributes: {},
    children: [
      {
        id: 42,
        identifier: '11111111-2222-3333-4444-555555555555',
        name: 'Sprint 1',
        attributes: { startDate: '2025-06-01T00:00:00Z', finishDate: '2025-06-14T00:00:00Z' },
        children: [],
      },
    ],
  };
  const map = await fetchIterationMap(fakeClassificationClient(root));
  const sprint = map.get('Proj\\Sprint 1');
  assert.strictEqual(sprint.id, '11111111-2222-3333-4444-555555555555');
  assert.notStrictEqual(sprint.id, 42, 'the classificationnodes integer id must never be exposed as the capacity-lookup id');
});

test('a node missing `identifier` (unlikely, but not fatal) falls back to null rather than the integer id', async () => {
  const root = { id: 1, name: 'Proj', attributes: {}, children: [{ id: 2, name: 'Sprint X', attributes: {}, children: [] }] };
  const map = await fetchIterationMap(fakeClassificationClient(root));
  assert.strictEqual(map.get('Proj\\Sprint X').id, null);
});

module.exports = run;

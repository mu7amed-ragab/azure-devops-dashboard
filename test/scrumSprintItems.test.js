/** T004d: the sprint item read's isolation re-check, tag splitting, batching. */

const { suite, test, run, assert } = require('./harness');
const { fetchSprintItems, BASE_FIELDS } = require('../server/ado/sprintItems');
const { createFakeClient, workItem } = require('./fixtures/fakeClient');

suite('sprint item read: isolation and shape');

test('an item whose System.TeamProject differs from the scope is dropped', async () => {
  const workItems = {
    ...workItem({ id: 1, type: 'User Story', state: 'Active', teamProject: 'ProjectA', title: 'Mine' }),
    ...workItem({ id: 2, type: 'User Story', state: 'Active', teamProject: 'ProjectB', title: 'Not mine' }),
  };
  const client = createFakeClient({ project: 'ProjectA', workItems });
  const items = await fetchSprintItems(client, [1, 2]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, 1);
});

test('System.Tags is split, trimmed, and case-preserved as an array', async () => {
  const workItems = workItem({ id: 1, type: 'Task', state: 'Active', teamProject: 'P', tags: ' Blocked ; waiting-vendor ' });
  const client = createFakeClient({ project: 'P', workItems });
  const [item] = await fetchSprintItems(client, [1]);
  assert.deepStrictEqual(item.tags, ['Blocked', 'waiting-vendor']);
});

test('ids are batched at 200 per request', async () => {
  const ids = Array.from({ length: 450 }, (_, i) => i + 1);
  const workItems = {};
  for (const id of ids) Object.assign(workItems, workItem({ id, type: 'Task', state: 'New', teamProject: 'P' }));
  const client = createFakeClient({ project: 'P', workItems });
  await fetchSprintItems(client, ids);
  const batchCalls = client.calls.filter((c) => c.apiPath === '/wit/workitemsbatch');
  assert.strictEqual(batchCalls.length, 3, '450 ids at 200/batch is 3 requests');
});

test('the configured blocked field is requested only when the project names one', async () => {
  const workItems = workItem({ id: 1, type: 'Task', state: 'New', teamProject: 'P' });
  const client = createFakeClient({ project: 'P', workItems });

  await fetchSprintItems(client, [1]);
  await fetchSprintItems(client, [1], { blockedField: 'Microsoft.VSTS.CMMI.Blocked' });

  assert.ok(!BASE_FIELDS.includes('Microsoft.VSTS.CMMI.Blocked'), 'not a base field');
});

test('a missing estimate field never appears in the requested field list', async () => {
  let capturedBody = null;
  const client = createFakeClient({ project: 'P', workItems: workItem({ id: 1, type: 'Task', state: 'New', teamProject: 'P' }) });
  const originalPost = client.post.bind(client);
  client.post = async (path, body) => {
    capturedBody = body;
    return originalPost(path, body);
  };
  await fetchSprintItems(client, [1]);
  assert.ok(!capturedBody.fields.some((f) => f.includes('StoryPoints')));
});

module.exports = run;

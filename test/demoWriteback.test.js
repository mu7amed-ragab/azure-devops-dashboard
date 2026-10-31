/**
 * Writes in demo mode go through the app's real write path (re-read, owner
 * check, `rev` concurrency) and land in the demo organization exactly as an
 * Azure DevOps write would: a new revision attributed to the writer. A reset
 * puts everything back.
 */

const { suite, test, run, assert } = require('./harness');
const { withDemoConfig } = require('./fixtures/demoConfig');
const { buildTestApp, signIn } = require('./fixtures/demoFlows');
const { AdoClient } = require('../server/ado/client');

const MONA = 'mona.ahmed@masar.dev';

function openTaskOf(state, uniqueName, project = 'Customer Experience Portal') {
  return [...state.workItems.values()].find(
    (i) =>
      i.fields['System.TeamProject'] === project &&
      i.fields['System.WorkItemType'] === 'Task' &&
      i.fields['System.AssignedTo'] &&
      i.fields['System.AssignedTo'].uniqueName === uniqueName &&
      ['New', 'Active'].includes(i.fields['System.State']) &&
      Number(i.fields['Microsoft.VSTS.Scheduling.RemainingWork']) > 2 &&
      i.fields['System.Parent']
  );
}

async function withDemoApp(fn) {
  await withDemoConfig(async (config) => {
    const built = await buildTestApp(config);
    try {
      await fn({ ...built, config, state: require('../server/demo').getState() });
    } finally {
      await built.close();
    }
  });
}

suite('demo writes');

test('logging hours adds one revision by the writer and changes the hours', async () => {
  await withDemoApp(async ({ app, config, state }) => {
    const { s } = await signIn(app, config.cookieNames, 'demo-lead', 'Customer Experience Portal');
    const task = openTaskOf(state, MONA);
    assert.ok(task, 'the lead has an open task');
    const rev = task.rev;
    const completed = Number(task.fields['Microsoft.VSTS.Scheduling.CompletedWork']) || 0;
    const res = await s.call('POST', `/api/tasks/${task.id}/log-hours`, { hours: 2 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(task.rev, rev + 1);
    assert.strictEqual(Number(task.fields['Microsoft.VSTS.Scheduling.CompletedWork']), completed + 2);
    assert.strictEqual(task.revisions[task.revisions.length - 1].fields['System.ChangedBy'].uniqueName, MONA);
  });
});

test("a teammate's item and an unknown state are refused before any write", async () => {
  await withDemoApp(async ({ app, config, state }) => {
    const { s } = await signIn(app, config.cookieNames, 'demo-lead', 'Customer Experience Portal');
    const theirs = [...state.workItems.values()].find(
      (i) => i.fields['System.TeamProject'] === 'Customer Experience Portal' && i.fields['System.WorkItemType'] === 'Task' && i.fields['System.AssignedTo'] && i.fields['System.AssignedTo'].uniqueName !== MONA && i.fields['System.State'] !== 'Closed'
    );
    const theirRev = theirs.rev;
    const refused = await s.call('POST', `/api/tasks/${theirs.id}/log-hours`, { hours: 1 });
    assert.ok(refused.status >= 400, `expected a refusal, got ${refused.status}`);
    assert.strictEqual(theirs.rev, theirRev);

    const mine = openTaskOf(state, MONA);
    const mineRev = mine.rev;
    const bogus = await s.call('POST', `/api/workitems/${mine.id}/state`, { state: 'Shipped' });
    assert.ok(bogus.status >= 400, `expected a refusal, got ${bogus.status}`);
    assert.strictEqual(mine.rev, mineRev);
  });
});

test('a stale rev is a 409 and a stale wiki ETag is a 412, as Azure DevOps answers', async () => {
  await withDemoApp(async ({ config, state }) => {
    const client = new AdoClient({ ...config, project: 'Customer Experience Portal', pat: 'demo-lead' });
    const task = openTaskOf(state, MONA);
    await assert.rejects(
      client.patch(`/wit/workitems/${task.id}`, [
        { op: 'test', path: '/rev', value: task.rev - 1 },
        { op: 'add', path: '/fields/System.Title', value: 'x' },
      ]),
      (err) => err.status === 409
    );
    const url = `https://dev.azure.com/masar/Customer%20Experience%20Portal/_apis/wiki/wikis/Customer%20Experience%20Portal.wiki/pages?path=${encodeURIComponent('/Dashboard Roles')}&api-version=7.1-preview.1`;
    await assert.rejects(
      client.request(url, { method: 'PUT', body: { content: 'x' }, headers: { 'If-Match': '"999"' }, rawResponse: true }),
      (err) => err.status === 412
    );
  });
});

test('moving a task back to its parent story’s sprint updates its iteration', async () => {
  await withDemoApp(async ({ app, config, state }) => {
    const { s } = await signIn(app, config.cookieNames, 'demo-lead', 'Customer Experience Portal');
    const task = openTaskOf(state, MONA);
    const parent = state.workItems.get(task.fields['System.Parent']);
    const other = state.projects[0].iterations.flat.find((it) => it.path !== parent.fields['System.IterationPath']);
    const client = new AdoClient({ ...config, project: 'Customer Experience Portal', pat: 'demo-lead' });
    await client.patch(`/wit/workitems/${task.id}`, [
      { op: 'test', path: '/rev', value: task.rev },
      { op: 'add', path: '/fields/System.IterationPath', value: other.path },
    ]);
    const res = await s.call('POST', `/api/workitems/${task.id}/move-to-parent-iteration`, {});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(task.fields['System.IterationPath'], parent.fields['System.IterationPath']);
  });
});

test('reset restores the seed for the owner and is refused for anyone else', async () => {
  await withDemoApp(async ({ app, config, state }) => {
    const lead = (await signIn(app, config.cookieNames, 'demo-lead', 'Customer Experience Portal')).s;
    const member = (await signIn(app, config.cookieNames, 'demo-member', 'Customer Experience Portal')).s;
    const task = openTaskOf(state, MONA);
    const { id, rev } = task;
    await lead.call('POST', `/api/tasks/${id}/log-hours`, { hours: 1 });
    assert.strictEqual(require('../server/demo').getState().workItems.get(id).rev, rev + 1);
    assert.strictEqual((await member.call('POST', '/api/demo/reset')).status, 403);
    const res = await lead.call('POST', '/api/demo/reset');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(require('../server/demo').getState().workItems.get(id).rev, rev);
  });
});

module.exports = run;

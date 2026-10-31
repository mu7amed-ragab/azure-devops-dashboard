/**
 * Every data view of the app, driven through its real HTTP routes against
 * the demo organization: each must come back populated, and the demo must
 * have answered every Azure DevOps call the app made — an unanswered call
 * would otherwise show up only as an empty card in a screenshot.
 */

const { suite, test, run, assert } = require('./harness');
const { withDemoConfig } = require('./fixtures/demoConfig');
const { runAllFlows, buildTestApp, PROJECTS } = require('./fixtures/demoFlows');
const { getRealRequestCount } = require('../server/ado/client');

suite('demo end to end');

test('every view is populated, nothing went unanswered, and no real request was made', async () => {
  const before = getRealRequestCount();
  await withDemoConfig(async (config) => {
    const { app, close } = await buildTestApp(config);
    try {
      const r = await runAllFlows({ app, config });
      const ok = (key) => {
        assert.ok(r[key], `missing flow ${key}`);
        assert.strictEqual(r[key].status, 200, `${key} answered ${r[key].status}: ${JSON.stringify(r[key].body).slice(0, 200)}`);
        return r[key].body;
      };

      for (const who of ['lead', 'member', 'principal']) {
        for (const [step, res] of Object.entries(r[`signin:${who}`])) assert.strictEqual(res.status, 200, `${who} ${step}`);
        assert.strictEqual(ok(`me:${who}`).demo, true);
      }
      assert.deepStrictEqual(r['signin:lead'].projects.body.projects.map((p) => p.name), [...PROJECTS].sort());

      for (const project of PROJECTS) {
        const dash = ok(`dashboard:${project}`);
        assert.ok((dash.groups || []).length > 0 || (dash.stories || []).length > 0, `${project} dashboard is empty`);
        assert.ok(Object.keys(ok(`states:${project}`)).length > 0);
      }
      ok('team:Customer Experience Portal');
      ok('team:Smart Operations Platform');

      const velocity = ok('scrum:velocity').data;
      assert.ok(velocity.sprints.length >= 4, 'velocity window');
      assert.ok(velocity.sprints.some((s) => s.overDistributedStoryIds.length > 0), 'an over-distribution disclosure');
      assert.ok(ok('scrum:progress').data.stories.length > 0, 'sprint progress');
      const util = ok('scrum:utilisation').data.members;
      assert.ok(util.some((m) => m.loggedHours > 0), 'utilisation hours');
      assert.ok(ok('scrum:burndown').data.points.length > 5, 'burndown points');
      const imp = ok('scrum:impediments').data.items;
      assert.ok(imp.some((i) => i.condition === 'blocked') && imp.some((i) => i.condition === 'stalled'), 'blocked and stalled');
      const scope = ok('scrum:scope-change').data;
      assert.ok(scope.events.some((e) => e.kind === 'added'), 'scope added');
      ok('scrum:blocked-convention');

      const cross = ok('crossHours');
      assert.strictEqual(cross.status, 'ready');
      assert.ok(cross.projects.filter((p) => p.hours > 0).length >= 2, 'hours from 2+ projects');

      assert.ok(ok('search').results.length > 0, 'past-ownership search');
      const repos = ok('repos').repos;
      assert.ok(repos.length >= 4, 'PR repositories');
      const anyCrossProject = Object.values(r.pullrequestsByRepo).some((res) => res.status === 200 && res.body.projectName !== 'Customer Experience Portal');
      assert.ok(anyCrossProject, 'a PR from a repository outside the signed-in project');
      ok('org');
      ok('people');
      ok('peopleSearch');
      assert.ok(r.taskId, 'found one of the lead’s tasks');
      ok('taskHours');

      assert.strictEqual(r['member:team'].status, 403, 'a developer cannot open the Team page');
      assert.strictEqual(r['member:scrum'].status, 403, 'a developer cannot open the Scrum page');

      const state = require('../server/demo').getState();
      assert.deepStrictEqual([...state.unhandled], [], 'every ADO call was answered');
      assert.deepStrictEqual(state.handlerErrors, [], 'no demo handler failed');
    } finally {
      await close();
    }
  });
  assert.strictEqual(getRealRequestCount(), before, 'no real network request');
});

module.exports = run;

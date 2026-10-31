/**
 * T019/T019a: the Scrum page must never leak between projects, and must
 * introduce no new WIQL query (Constitution Principle I) — velocity derives
 * sprint/story membership entirely from the project's own revision index
 * and a project-scoped batch item read, per research.md R2.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { Cache } = require('../server/cache');
const { SyncEngine } = require('../server/sync');
const { ScrumEngine } = require('../server/scrum');
const { buildScopeConfig } = require('../server/scopes');
const { createFakeClient, workItem } = require('./fixtures/fakeClient');
const { AGILE, SCRUM } = require('./fixtures/processes');

const A = { id: 'aaaaaaaa-1111-1111-1111-111111111111', name: 'ProjectA' };
const B = { id: 'bbbbbbbb-2222-2222-2222-222222222222', name: 'ProjectB' };

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-scrum-${label}-`));
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

/** Seeds a project's revision index directly (bypassing a real walk) with
 * one story that has one completed-work delta inside one sprint, and wires
 * up the iteration map + estimate field the same way a real sync would. */
function seedScope(baseConfig, project, process, { storyId, sprintPath, points }) {
  const config = buildScopeConfig(baseConfig, project, { readTokenIsService: true });
  const cache = new Cache(config.cacheDir);
  const engine = new SyncEngine({ ...config, pat: 'service-pat' }, cache, cache);
  engine.setClient(
    createFakeClient({
      project: project.name,
      process,
      workItems: workItem({ id: storyId, type: process.categories[0].workItemTypes[0].name, state: 'Closed', teamProject: project.name, title: `${project.name} story` }),
    })
  );
  engine.iterationMap = new Map([
    [sprintPath, { id: 1, name: sprintPath, path: sprintPath, startDate: '2026-01-01', finishDate: '2026-01-14' }],
  ]);
  const requirementType = process.categories[0].workItemTypes[0].name;
  engine.revisionIndex.set(storyId, [
    { rev: 1, changedDate: '2026-01-02', changedBy: 'a@x.com', completedWork: 0, remainingWork: points, state: 'New', iterationPath: sprintPath, estimate: points, workItemType: requirementType, parentId: null },
    { rev: 2, changedDate: '2026-01-10', changedBy: 'a@x.com', completedWork: points, remainingWork: 0, state: 'Closed', iterationPath: sprintPath, estimate: points, workItemType: requirementType, parentId: null },
  ]);
  const scrum = new ScrumEngine(config, cache, engine);
  return { config, cache, engine, scrum };
}

suite('Scrum page: project isolation (SC-005, FR-004, FR-025)');

test('two projects with the SAME sprint path and overlapping story ids stay independent', async () => {
  const base = baseConfigIn(tmpRoot('velocity-isolation'));
  const sprintPath = 'Team\\Sprint 1'; // deliberately identical across both projects
  const a = seedScope(base, A, AGILE, { storyId: 1, sprintPath, points: 5 });
  const b = seedScope(base, B, SCRUM, { storyId: 1, sprintPath, points: 8 }); // same id, different points

  const [velA, velB] = await Promise.all([a.scrum.getVelocity({ windowSize: 6 }), b.scrum.getVelocity({ windowSize: 6 })]);

  assert.strictEqual(velA.sprints[0].total, 5);
  assert.strictEqual(velB.sprints[0].total, 8);
  assert.notStrictEqual(velA.sprints[0].total, velB.sprints[0].total, 'must not have merged');
});

test("each project's client only ever asks its own project's URLs during velocity", async () => {
  const base = baseConfigIn(tmpRoot('velocity-urls'));
  const a = seedScope(base, A, AGILE, { storyId: 1, sprintPath: 'Team\\Sprint 1', points: 5 });
  await a.scrum.getVelocity({ windowSize: 6 });
  assert.ok(a.engine.client.calls.every((c) => c.project === 'ProjectA'));
});

test('velocity introduces no WIQL query at all (Constitution Principle I)', async () => {
  const base = baseConfigIn(tmpRoot('velocity-no-wiql'));
  const a = seedScope(base, A, AGILE, { storyId: 1, sprintPath: 'Team\\Sprint 1', points: 5 });
  await a.scrum.getVelocity({ windowSize: 6 });
  const wiqlCalls = a.engine.client.calls.filter((c) => c.apiPath === '/wit/wiql');
  assert.strictEqual(wiqlCalls.length, 0, 'sprint/story membership comes from the revision index and workitemsbatch only');
});

test("velocity's cache entry lands in the project's own directory, never the other's", async () => {
  const base = baseConfigIn(tmpRoot('velocity-cache'));
  const sprintPath = 'Team\\Sprint 1';
  // A closed sprint's cache is only written once its status is 'past' AND
  // A2's two-ended coverage check passes: the sprint's own start at/after
  // INDEX_START_DATE, and the watermark at/after its finish — so both bounds
  // need real, index-covered dates rather than the pre-2025 dates that used
  // to make the single-ended check pass trivially.
  const a = seedScope(base, A, AGILE, { storyId: 1, sprintPath, points: 5 });
  a.engine.iterationMap.set(sprintPath, { id: 1, name: sprintPath, path: sprintPath, startDate: '2026-01-01', finishDate: '2026-01-14' });
  a.engine.revisionWatermark = '2026-02-01T00:00:00Z';
  await a.scrum.getVelocity({ windowSize: 6 });
  assert.ok(fs.existsSync(path.join(a.config.cacheDir, `scrum-velocity-v2-${encodeURIComponent(sprintPath)}.json`)));
});

suite('Scrum page: every route is read-only against Azure DevOps (FR-006)');

test('every /api/scrum view issues no PATCH/POST/PUT to /wit/ or /work/ — only reads', async () => {
  const base = baseConfigIn(tmpRoot('read-only'));
  const sprintPath = 'Team\\Sprint 1';
  const { engine, scrum } = seedScope(base, A, AGILE, { storyId: 1, sprintPath, points: 5 });
  engine.iterationMap.set(sprintPath, { id: 1, name: sprintPath, path: sprintPath, startDate: '2020-01-01', finishDate: '2020-01-14' });

  await Promise.all([
    scrum.getVelocity({ windowSize: 6 }),
    scrum.getProgress({ sprintPath }),
    scrum.getUtilisation({ sprintPath }),
    scrum.getBurndown({ sprintPath }),
    scrum.getImpediments({ sprintPath }),
    scrum.getScopeChange({ sprintPath }),
    scrum.getBlockedConvention(),
  ]);

  // /wit/workitemsbatch and /wit/wiql are reads despite being POST requests
  // — a WRITE here means PATCH/PUT anywhere, or POST to something else.
  const writes = engine.client.calls.filter((c) => {
    const isReadPost = c.method === 'POST' && (c.apiPath === '/wit/workitemsbatch' || c.apiPath === '/wit/wiql');
    const touchesWitOrWork = /\/wit\/|\/work\//.test(c.apiPath);
    if (c.method === 'PATCH') return touchesWitOrWork;
    if (c.method === 'PUT') return touchesWitOrWork;
    if (c.method === 'POST') return touchesWitOrWork && !isReadPost;
    return false;
  });
  assert.deepStrictEqual(writes, [], `expected no ADO writes, got ${JSON.stringify(writes)}`);
});

module.exports = run;

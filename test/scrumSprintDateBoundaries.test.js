/**
 * Regression for two related code-review findings:
 *
 * 1. sync.js `getSprints()`: ADO's own `finishDate` is midnight at the
 *    START of the sprint's last calendar day (e.g. a sprint ending
 *    2025-06-14 carries "2025-06-14T00:00:00Z"), but every Scrum view
 *    treats a sprint's window as (startDate, finishDate] — used raw, that
 *    silently excluded the sprint's entire final day of logged hours and
 *    shifted it into the NEXT sprint's numbers.
 *
 * 2. server/scrum.js `getBurndown()`: iterated per calendar day with a bare
 *    YYYY-MM-DD string against `sync.getFieldAt`, which reads "as of
 *    00:00 that day" — so the sprint's last-day work (and same-day work on
 *    any day, including today) never showed up in its own day's point.
 *
 * Both are exercised together here: a real SyncEngine + ScrumEngine, with
 * revision history seeded directly (matching scrumVelocity.test.js's
 * pattern) rather than a live/fake ADO walk.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { Cache } = require('../server/cache');
const { SyncEngine } = require('../server/sync');
const { ScrumEngine } = require('../server/scrum');
const { buildScopeConfig } = require('../server/scopes');
const { createFakeClient } = require('./fixtures/fakeClient');
const { fetchWorkItemTypes } = require('../server/ado/workItemTypes');
const { fetchStatesForTypes } = require('../server/ado/states');
const { AGILE } = require('./fixtures/processes');

const PROJECT = { id: 'p1', name: 'ProjectX' };

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-sprintdates-${label}-`));
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

function entry({ rev, date, completed = null, remaining = null, state = null, iterationPath = null, estimate = null, type = null, parentId = null }) {
  return { rev, changedDate: date, changedBy: 'a@x.com', completedWork: completed, remainingWork: remaining, state, iterationPath, estimate, workItemType: type, parentId };
}

/** Mirrors ado/iterations.js's REAL raw shape from ADO: `finishDate` is
 * midnight at the start of the last day — never pre-adjusted here, so the
 * fix under test (getSprints' own normalization) is what's exercised. */
function mkIterationMap(defs) {
  const map = new Map();
  defs.forEach((d, i) => map.set(d.path, { id: `guid-${i + 1}`, name: d.path, path: d.path, startDate: `${d.start}T00:00:00Z`, finishDate: `${d.finish}T00:00:00Z` }));
  return map;
}

async function buildEngine({ sprintDefs, revisionEntries }) {
  const base = baseConfigIn(tmpRoot('t'));
  const config = buildScopeConfig(base, PROJECT, { readTokenIsService: true });
  const cache = new Cache(config.cacheDir);
  const engine = new SyncEngine({ ...config, pat: 'service-pat' }, cache, cache);
  const client = createFakeClient({ project: PROJECT.name, process: AGILE });
  engine.setClient(client);
  engine.types = await fetchWorkItemTypes(client);
  engine.states = await fetchStatesForTypes(client, engine.types.allTypes);
  engine.iterationMap = mkIterationMap(sprintDefs);
  for (const [id, entries] of revisionEntries) engine.revisionIndex.set(id, entries);
  return new ScrumEngine(config, cache, engine);
}

suite('sync.js getSprints(): finishDate is normalized to the END of the last calendar day');

test('a sprint\'s finishDate is midnight-start as returned by ADO on input, end-of-day on output', async () => {
  const scrum = await buildEngine({
    sprintDefs: [{ path: 'X\\Sprint 1', start: '2025-06-01', finish: '2025-06-14' }],
    revisionEntries: new Map(),
  });
  const { sprints } = await scrum.sync.getSprints();
  assert.strictEqual(sprints[0].finishDate, '2025-06-14T23:59:59.999Z');
});

suite('server/scrum.js getBurndown(): a revision on the sprint\'s FINAL calendar day lands on that day\'s point, not the next sprint\'s');

test('remaining-work logged in the afternoon of the sprint\'s last day is reflected in that day\'s burndown point', async () => {
  const requirementType = AGILE.categories[0].workItemTypes[0].name; // 'User Story'
  const storyId = 200;
  const scrum = await buildEngine({
    sprintDefs: [{ path: 'X\\Sprint 1', start: '2025-06-01', finish: '2025-06-14' }],
    revisionEntries: new Map([
      [
        storyId,
        [
          entry({ rev: 1, date: '2025-06-01T09:00:00Z', remaining: 10, type: requirementType, iterationPath: 'X\\Sprint 1' }),
          // The sprint's last calendar day, in the afternoon — well after
          // the "midnight of that day" boundary the pre-fix code effectively
          // used for BOTH the sprint's own finishDate AND every burndown
          // day's query.
          entry({ rev: 2, date: '2025-06-14T15:00:00Z', remaining: 0, type: requirementType, iterationPath: 'X\\Sprint 1' }),
        ],
      ],
    ]),
  });
  const result = await scrum.getBurndown({ sprintPath: 'X\\Sprint 1' });
  assert.strictEqual(result.tracked, true);
  const lastPoint = result.points[result.points.length - 1];
  assert.strictEqual(lastPoint.date, '2025-06-14');
  assert.strictEqual(lastPoint.remaining, 0, 'the last day\'s own afternoon revision must be visible on the last day\'s point');
});

test('day 0\'s point reflects same-day activity, not the value from before the sprint started', async () => {
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const storyId = 201;
  const scrum = await buildEngine({
    sprintDefs: [{ path: 'X\\Sprint 2', start: '2025-06-01', finish: '2025-06-14' }],
    revisionEntries: new Map([
      [
        storyId,
        [
          entry({ rev: 1, date: '2025-05-20T09:00:00Z', remaining: 40, type: requirementType, iterationPath: 'X\\Sprint 2' }),
          // Same-day-as-sprint-start work, done in the afternoon of day 0.
          entry({ rev: 2, date: '2025-06-01T14:00:00Z', remaining: 30, type: requirementType, iterationPath: 'X\\Sprint 2' }),
        ],
      ],
    ]),
  });
  const result = await scrum.getBurndown({ sprintPath: 'X\\Sprint 2' });
  assert.strictEqual(result.points[0].date, '2025-06-01');
  assert.strictEqual(result.points[0].remaining, 30, 'day 0 must include day 0\'s own activity, not stop at 00:00 that day');
});

module.exports = run;

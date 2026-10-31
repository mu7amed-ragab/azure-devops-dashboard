/**
 * US1 velocity: share conservation, immutability (via the cache, per
 * server/scrum.js's contract), arithmetic edge cases, whole-credit,
 * template-agnosticism, and the average.
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
const { fetchWorkItemTypes } = require('../server/ado/workItemTypes');
const { fetchStatesForTypes } = require('../server/ado/states');
const { AGILE, SCRUM, CMMI, CUSTOM, BASIC } = require('./fixtures/processes');

const PROJECT = { id: 'p1', name: 'ProjectX' };

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-vel-${label}-`));
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

/** Sprint metadata: `sprintDefs` is [{path, start, finish, status}]. Dates
 * are chosen deliberately in the past so every sprint is 'past' unless the
 * test says otherwise. */
function mkSprints(defs) {
  const map = new Map();
  defs.forEach((d, i) => map.set(d.path, { id: i + 1, name: d.path, path: d.path, startDate: d.start, finishDate: d.finish }));
  return map;
}

/** Builds a fully-wired ScrumEngine over a fake client, with process
 * discovery, states, and the estimate field pre-resolved through the real
 * discovery modules (against the fixture) rather than hand-rolled, so a
 * template's real shape drives the test. `workItems` back the sprint-item
 * title read; `revisionEntries` is Map<id, entry[]> seeded directly (a real
 * cold walk is exercised by revisionIndex.test.js, not here). */
async function buildEngine(proc, { sprintDefs, workItems, revisionEntries }) {
  const base = baseConfigIn(tmpRoot(proc.name));
  const config = buildScopeConfig(base, PROJECT, { readTokenIsService: true });
  const cache = new Cache(config.cacheDir);
  const engine = new SyncEngine({ ...config, pat: 'service-pat' }, cache, cache);
  const client = createFakeClient({ project: PROJECT.name, process: proc, workItems });
  engine.setClient(client);
  engine.types = await fetchWorkItemTypes(client);
  engine.states = await fetchStatesForTypes(client, engine.types.allTypes);
  engine.iterationMap = mkSprints(sprintDefs);
  for (const [id, entries] of revisionEntries) engine.revisionIndex.set(id, entries);
  return new ScrumEngine(config, cache, engine);
}

function entry({ rev, date, completed = null, remaining = null, state = null, iterationPath = null, estimate = null, type = null, parentId = null }) {
  return { rev, changedDate: date, changedBy: 'a@x.com', completedWork: completed, remainingWork: remaining, state, iterationPath, estimate, workItemType: type, parentId };
}

suite('US1 velocity: share conservation and caps');

test('a story spanning two sprints has shares summing to exactly its final estimate (SC-002)', async () => {
  const path1 = 'X\\Sprint 1';
  const path2 = 'X\\Sprint 2';
  const storyId = 100;
  const requirementType = AGILE.categories[0].workItemTypes[0].name; // 'User Story'
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [
      { path: path1, start: '2020-01-01', finish: '2020-01-14' },
      { path: path2, start: '2020-01-15', finish: '2020-01-28' },
    ],
    workItems: workItem({ id: storyId, type: requirementType, state: 'Closed', teamProject: PROJECT.name, title: 'Cross-sprint story' }),
    revisionEntries: new Map([
      [
        storyId,
        [
          entry({ rev: 1, date: '2020-01-02', completed: 0, remaining: 8, state: 'New', iterationPath: path1, estimate: 8, type: requirementType }),
          entry({ rev: 2, date: '2020-01-14', completed: 4, remaining: 4, state: 'Active', iterationPath: path1, estimate: 8, type: requirementType }),
          entry({ rev: 3, date: '2020-01-28', completed: 8, remaining: 0, state: 'Closed', iterationPath: path2, estimate: 8, type: requirementType }),
        ],
      ],
    ]),
  });

  const result = await scrum.getVelocity({ windowSize: 6 });
  const allShares = result.sprints.flatMap((s) => s.shares);
  const sum = allShares.reduce((acc, s) => acc + s.points, 0);
  assert.ok(Math.abs(sum - 8) < 1e-9, `shares must sum to 8, got ${sum}`);
});

test('no story contributes more than its estimate even when work overruns it (FR-008b-i)', async () => {
  const p1 = 'X\\Sprint 1';
  const storyId = 200;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
    workItems: workItem({ id: storyId, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
    revisionEntries: new Map([
      [
        storyId,
        [
          entry({ rev: 1, date: '2020-01-01', completed: 0, remaining: 5, state: 'New', iterationPath: p1, estimate: 5, type: requirementType }),
          // Overran: 20 hours completed against a 5-point estimate.
          entry({ rev: 2, date: '2020-01-14', completed: 20, remaining: 0, state: 'Closed', iterationPath: p1, estimate: 5, type: requirementType }),
        ],
      ],
    ]),
  });
  const result = await scrum.getVelocity({ windowSize: 6 });
  const total = result.sprints[0].shares.reduce((a, s) => a + s.points, 0);
  assert.ok(total <= 5 + 1e-9, `must be capped at the estimate, got ${total}`);
});

suite('US1 velocity: arithmetic edge cases');

test('a downward correction to completed work credits 0, never negative (FR-008a-i)', async () => {
  const p1 = 'X\\Sprint 1';
  const storyId = 300;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
    workItems: workItem({ id: storyId, type: requirementType, state: 'Active', teamProject: PROJECT.name }),
    revisionEntries: new Map([
      [
        storyId,
        [
          entry({ rev: 1, date: '2020-01-01', completed: 5, remaining: 3, state: 'Active', iterationPath: p1, estimate: 8, type: requirementType }),
          // Completed work went DOWN within the sprint (a correction).
          entry({ rev: 2, date: '2020-01-14', completed: 2, remaining: 6, state: 'Active', iterationPath: p1, estimate: 8, type: requirementType }),
        ],
      ],
    ]),
  });
  const result = await scrum.getVelocity({ windowSize: 6 });
  assert.strictEqual(result.sprints[0].total, 0, 'a negative delta must floor at 0, never go negative');
  // A9: a zero-point share nothing discloses (not capped, not
  // over-distributed, not whole-credit, not a completing remainder) is
  // trimmed from the wire payload — it adds nothing over the total above.
  assert.strictEqual(result.sprints[0].shares.length, 0);
});

suite('US1 velocity: whole credit');

test('a story with no measurable child/task work is credited whole at its completing sprint (FR-008e)', async () => {
  const p1 = 'X\\Sprint 1';
  const storyId = 400;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
    workItems: workItem({ id: storyId, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
    revisionEntries: new Map([
      [
        storyId,
        [
          // No CompletedWork/RemainingWork ever recorded on this story —
          // a points-only project with no task-hour tracking.
          entry({ rev: 1, date: '2020-01-01', state: 'New', iterationPath: p1, estimate: 3, type: requirementType }),
          entry({ rev: 2, date: '2020-01-14', state: 'Closed', iterationPath: p1, estimate: 3, type: requirementType }),
        ],
      ],
    ]),
  });
  const result = await scrum.getVelocity({ windowSize: 6 });
  const share = result.sprints[0].shares[0];
  assert.strictEqual(share.basis, 'whole-credit');
  assert.strictEqual(share.points, 3);
});

suite('US1 velocity: a boundary story\'s END state alone is not proof of an in-sprint transition');

test('a story already Closed before its first indexed revision (rev > 1) is never whole-credited to the sprint that merely happens to see it Closed', async () => {
  const p1 = 'X\\Sprint 1';
  const p2 = 'X\\Sprint 2';
  const storyId = 800;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [
      { path: p1, start: '2020-01-01', finish: '2020-01-14' },
      { path: p2, start: '2020-01-15', finish: '2020-01-28' },
    ],
    workItems: workItem({ id: storyId, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
    revisionEntries: new Map([
      [
        storyId,
        [
          // rev 5, not 1: this story's real history predates what the index
          // can see (same boundary signal as SyncEngine.ensureBoundarySeeded).
          // It shows up already Closed on its very first indexed touch,
          // mid-sprint-1 — that is NOT evidence it completed during sprint 1.
          entry({ rev: 5, date: '2020-01-10', state: 'Closed', iterationPath: p1, estimate: 8, type: requirementType }),
        ],
      ],
    ]),
  });
  const result = await scrum.getVelocity({ windowSize: 6 });
  const total = result.sprints.reduce((sum, s) => sum + s.total, 0);
  assert.strictEqual(total, 0, 'no sprint may claim credit for a completion that may predate the tracked window');
  for (const s of result.sprints) {
    assert.strictEqual(s.wholeCreditPortion, 0, `${s.sprintPath} must not carry whole-credit for an unproven completion`);
  }
});

test('a boundary story (rev > 1) with a genuine visible transition (known non-Completed start state -> Completed end state) is still credited normally', async () => {
  const p1 = 'X\\Sprint 1';
  const storyId = 801;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
    workItems: workItem({ id: storyId, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
    revisionEntries: new Map([
      [
        storyId,
        [
          // Also rev > 1 (boundary), but this time the sprint's START state
          // is known and NOT Completed — real evidence the transition to
          // Closed happened inside this sprint.
          entry({ rev: 5, date: '2020-01-01', state: 'Active', iterationPath: p1, estimate: 8, type: requirementType }),
          entry({ rev: 6, date: '2020-01-14', state: 'Closed', iterationPath: p1, estimate: 8, type: requirementType }),
        ],
      ],
    ]),
  });
  const result = await scrum.getVelocity({ windowSize: 6 });
  assert.strictEqual(result.sprints[0].total, 8, 'a genuine in-sprint transition is still whole-credited');
});

suite('US1 velocity: A2 — the freeze guard checks BOTH ends of index coverage, not just the watermark');

test('a sprint that started before INDEX_START_DATE is never cached, even though it is "past" and the watermark trivially exceeds it', async () => {
  const p1 = 'X\\Sprint 1';
  const storyId = 750;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine(AGILE, {
    // Genuinely pre-index: this sprint ended well before INDEX_START_DATE
    // (2025-01-01) — the default watermark (also 2025-01-01) trivially
    // exceeds this sprint's finish, which is exactly what let the old
    // single-ended check freeze a confidently-wrong answer.
    sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
    workItems: workItem({ id: storyId, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
    revisionEntries: new Map([
      [
        storyId,
        [
          entry({ rev: 1, date: '2020-01-01', completed: 0, remaining: 5, state: 'New', iterationPath: p1, estimate: 5, type: requirementType }),
          entry({ rev: 2, date: '2020-01-14', completed: 5, remaining: 0, state: 'Closed', iterationPath: p1, estimate: 5, type: requirementType }),
        ],
      ],
    ]),
  });
  await scrum.getVelocity({ windowSize: 6 });
  assert.strictEqual(
    fs.existsSync(path.join(scrum.config.cacheDir, `scrum-velocity-v2-${encodeURIComponent(p1)}.json`)),
    false,
    'a pre-INDEX_START_DATE sprint must never be frozen — its "0 history" is absence of evidence, not evidence of zero'
  );
});

suite('US1 velocity: A3 — noMeasurableWork is disclosed, not silently zero');

test('a story with a real estimate that never completes and never has any measurable work is excluded and counted', async () => {
  const p1 = 'X\\Sprint 1';
  const storyId = 760;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
    workItems: workItem({ id: storyId, type: requirementType, state: 'New', teamProject: PROJECT.name }),
    revisionEntries: new Map([
      [
        storyId,
        [
          // Estimated, but never touched with completed/remaining work, and
          // never reaches Completed within the window.
          entry({ rev: 1, date: '2020-01-01', state: 'New', iterationPath: p1, estimate: 5, type: requirementType }),
        ],
      ],
    ]),
  });
  const result = await scrum.getVelocity({ windowSize: 6 });
  assert.strictEqual(result.sprints[0].shares.length, 0, 'the story contributes no share at all');
  assert.strictEqual(result.sprints[0].exclusions.noMeasurableWork, 1, 'and the exclusion is disclosed rather than reading as a silent zero');
});

suite('US1 velocity: A4 — a cap from the proportional branch does not survive the completing-sprint override');

test('a story capped mid-sprint that ALSO completes in that same sprint reports no cap — the completing branch replaced the number the cap applied to', () => {
  const shares = distributeStory({
    id: 9,
    title: 'S',
    perSprint: [
      // Proportional branch would compute points > estimateAtEnd here, so
      // `capped` gets set to true — but this sprint is ALSO the completing
      // sprint, so the whole-credit/remainder branch overwrites `points`
      // right after.
      { sprintPath: 'A', deltaCompleted: 10, totalAtEnd: 10, estimateAtEnd: 5 },
    ],
    completingSprintPath: 'A',
    finalEstimate: 5,
  });
  assert.strictEqual(shares[0].capped, false, 'the cap never actually constrained the number that shipped (the completing branch replaced it)');
  assert.strictEqual(shares[0].points, 5);
});

test('a story capped in a sprint that is NOT the completing sprint still discloses the cap', () => {
  const shares = distributeStory({
    id: 10,
    title: 'S',
    perSprint: [
      // fraction = 15/10 = 1.5, proportional points = 1.5*5 = 7.5 > estimate
      // (5) -> genuinely capped down to 5, and this sprint never gets
      // overwritten by the completing branch (that's sprint B).
      { sprintPath: 'A', deltaCompleted: 15, totalAtEnd: 10, estimateAtEnd: 5 },
      { sprintPath: 'B', deltaCompleted: 0, totalAtEnd: 10, estimateAtEnd: 5 }, // completing
    ],
    completingSprintPath: 'B',
    finalEstimate: 5,
  });
  assert.strictEqual(shares[0].capped, true, 'a non-completing sprint\'s cap is real and must still be reported');
  assert.strictEqual(shares[0].points, 5);
});

suite('US1 velocity: A7 — a task reparented after a sprint closes must not move that sprint\'s already-frozen hours');

test('reparenting a task from story A to story B AFTER sprint 1 closes leaves sprint 1\'s shares unchanged', async () => {
  const p1 = 'X\\Sprint 1';
  const p2 = 'X\\Sprint 2';
  const storyA = 900;
  const storyB = 901;
  const taskId = 902;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const taskType = AGILE.categories.find((c) => c.workItemTypes.some((t) => t.name !== requirementType)).workItemTypes.find((t) => t.name !== requirementType).name;

  const scrum = await buildEngine(AGILE, {
    sprintDefs: [
      { path: p1, start: '2020-01-01', finish: '2020-01-14' },
      { path: p2, start: '2020-01-15', finish: '2020-01-28' },
    ],
    workItems: {
      ...workItem({ id: storyA, type: requirementType, state: 'Active', teamProject: PROJECT.name }),
      ...workItem({ id: storyB, type: requirementType, state: 'Active', teamProject: PROJECT.name }),
    },
    revisionEntries: new Map([
      [storyA, [entry({ rev: 1, date: '2020-01-01', state: 'Active', iterationPath: p1, estimate: 5, type: requirementType })]],
      [storyB, [entry({ rev: 1, date: '2020-01-01', state: 'Active', iterationPath: p1, estimate: 5, type: requirementType })]],
      [
        taskId,
        [
          // Under story A during sprint 1, where all its hours are logged.
          entry({ rev: 1, date: '2020-01-02', completed: 0, remaining: 5, iterationPath: p1, type: taskType, parentId: storyA }),
          entry({ rev: 2, date: '2020-01-10', completed: 5, remaining: 0, iterationPath: p1, type: taskType, parentId: storyA }),
          // Reparented to story B in sprint 2, AFTER sprint 1 has closed.
          entry({ rev: 3, date: '2020-01-20', completed: 5, remaining: 0, iterationPath: p2, type: taskType, parentId: storyB }),
        ],
      ],
    ]),
  });
  scrum.sync.revisionWatermark = '2020-02-01T00:00:00Z';

  const first = await scrum.getVelocity({ windowSize: 6 });
  const sprint1 = first.sprints.find((s) => s.sprintPath === p1);
  const storyAShare1 = sprint1.shares.find((s) => s.storyId === storyA);
  const storyBShare1 = sprint1.shares.find((s) => s.storyId === storyB);
  assert.ok(
    storyAShare1 && storyAShare1.points > 0,
    "sprint 1 must still credit story A with the task's hours, which were genuinely logged while it was A's child THEN — using the task's CURRENT parent (story B) here would show story A as having no measurable work at all"
  );
  assert.ok(
    !storyBShare1 || storyBShare1.points === 0,
    "story B must NOT retroactively inherit sprint 1 credit for a task that was not yet its child during sprint 1"
  );

  // Recompute again (simulating a later request, well after the reparent) —
  // sprint 1 is now cached/frozen, so this must return the byte-identical
  // figure rather than the task's CURRENT parent (story B) retroactively
  // stealing sprint 1's already-closed credit.
  const second = await scrum.getVelocity({ windowSize: 6 });
  const sprint1Again = second.sprints.find((s) => s.sprintPath === p1);
  assert.deepStrictEqual(sprint1Again, sprint1, "sprint 1's frozen figure must not change after the task's CURRENT parent changes");
});

suite('US1 velocity: FR-013a — unavailable, not zero, when the project has no estimate field');

test('Basic has no story-level estimate field: unitAvailable is false and sprints is empty', async () => {
  const scrum = await buildEngine(BASIC, {
    sprintDefs: [{ path: 'X\\Sprint 1', start: '2020-01-01', finish: '2020-01-14' }],
    workItems: {},
    revisionEntries: new Map(),
  });
  const result = await scrum.getVelocity({ windowSize: 6 });
  assert.strictEqual(result.unitAvailable, false);
  assert.deepStrictEqual(result.sprints, []);
  assert.strictEqual(result.average, null);
});

suite('US1 velocity: template-agnosticism (SC-004, FR-007a)');

for (const proc of [AGILE, SCRUM, CMMI, CUSTOM]) {
  test(`${proc.name}: a simple one-sprint story reports its estimate as velocity, using that template's own type name`, async () => {
    const p1 = 'X\\Sprint 1';
    const storyId = 500;
    const requirementType = proc.categories[0].workItemTypes[0].name;
    const scrum = await buildEngine(proc, {
      sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
      workItems: workItem({ id: storyId, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
      revisionEntries: new Map([
        [
          storyId,
          [
            entry({ rev: 1, date: '2020-01-01', completed: 0, remaining: 5, state: 'New', iterationPath: p1, estimate: 5, type: requirementType }),
            entry({ rev: 2, date: '2020-01-14', completed: 5, remaining: 0, state: 'Closed', iterationPath: p1, estimate: 5, type: requirementType }),
          ],
        ],
      ]),
    });
    const result = await scrum.getVelocity({ windowSize: 6 });
    assert.strictEqual(result.unitAvailable, true);
    assert.ok(Math.abs(result.sprints[0].total - 5) < 1e-9, `${proc.name}: expected 5, got ${result.sprints[0].total}`);
  });
}

suite('US1 velocity: a stale/incomplete index must never freeze a wrong answer');

test('a past sprint is not cached until the revision index watermark actually reaches its end date', async () => {
  const p1 = 'X\\Sprint 1';
  const storyId = 700;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
    workItems: workItem({ id: storyId, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
    revisionEntries: new Map([
      [
        storyId,
        [
          entry({ rev: 1, date: '2020-01-01', completed: 0, remaining: 5, state: 'New', iterationPath: p1, estimate: 5, type: requirementType }),
          entry({ rev: 2, date: '2020-01-14', completed: 5, remaining: 0, state: 'Closed', iterationPath: p1, estimate: 5, type: requirementType }),
        ],
      ],
    ]),
  });
  // Simulate a stale index: its watermark never advanced past the sprint's
  // own dates (e.g. nobody has opened this project in months).
  scrum.sync.revisionWatermark = '2019-06-01T00:00:00Z';

  const first = await scrum.getVelocity({ windowSize: 6 });
  assert.strictEqual(first.sprints[0].total, 5, 'still computes the right answer from what history it has');
  assert.strictEqual(
    fs.existsSync(path.join(scrum.config.cacheDir, `scrum-velocity-v2-${encodeURIComponent(p1)}.json`)),
    false,
    'must NOT have been cached — the index has not caught up to this sprint\'s end yet'
  );

  // Now the index catches up (a real sync ran) and discovers new work — the
  // 3-point re-estimate a person makes after the fact.
  scrum.sync.revisionWatermark = '2020-02-01T00:00:00Z';
  scrum.sync.revisionIndex.get(storyId).push(
    entry({ rev: 3, date: '2020-01-20', completed: 5, remaining: 0, state: 'Closed', iterationPath: p1, estimate: 8, type: requirementType })
  );
  const second = await scrum.getVelocity({ windowSize: 6 });
  assert.ok(second.sprints[0].total > 0, 'now that the index has caught up, it is computed and cached');
});

suite('US1 velocity: closed-sprint immutability (SC-002a, FR-008c)');

test('recomputing a closed sprint after later work on its stories returns the identical figure', async () => {
  const p1 = 'X\\Sprint 1';
  const storyId = 650;
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [{ path: p1, start: '2020-01-01', finish: '2020-01-14' }],
    workItems: workItem({ id: storyId, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
    revisionEntries: new Map([
      [
        storyId,
        [
          entry({ rev: 1, date: '2020-01-01', completed: 0, remaining: 5, state: 'New', iterationPath: p1, estimate: 5, type: requirementType }),
          entry({ rev: 2, date: '2020-01-14', completed: 5, remaining: 0, state: 'Closed', iterationPath: p1, estimate: 5, type: requirementType }),
        ],
      ],
    ]),
  });
  scrum.sync.revisionWatermark = '2020-02-01T00:00:00Z'; // caught up, safe to freeze

  const first = await scrum.getVelocity({ windowSize: 6 });
  assert.strictEqual(first.sprints[0].total, 5);

  // Later work happens on the SAME story after the sprint closed — e.g. a
  // fresh sync discovers a revision that (were it re-read) would change the
  // figure. The cached entry must not move.
  scrum.sync.revisionIndex.get(storyId).push(
    entry({ rev: 3, date: '2020-03-01', completed: 5, remaining: 0, state: 'Closed', iterationPath: p1, estimate: 20, type: requirementType })
  );
  const second = await scrum.getVelocity({ windowSize: 6 });
  assert.strictEqual(second.sprints[0].total, 5, "a closed sprint's cached figure must not move");
});

suite('US1 velocity: average excludes provisional sprints (FR-011, FR-012)');

test('an in-progress (current) sprint is marked provisional and excluded from the average', async () => {
  const past = 'X\\Sprint 1';
  const current = 'X\\Sprint 2';
  const today = new Date();
  const inTwoWeeks = new Date(today.getTime() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const storyPast = 600;
  const storyCurrent = 601;
  const scrum = await buildEngine(AGILE, {
    sprintDefs: [
      { path: past, start: '2020-01-01', finish: '2020-01-14' },
      { path: current, start: yesterday, finish: inTwoWeeks },
    ],
    workItems: {
      ...workItem({ id: storyPast, type: requirementType, state: 'Closed', teamProject: PROJECT.name }),
      ...workItem({ id: storyCurrent, type: requirementType, state: 'Active', teamProject: PROJECT.name }),
    },
    revisionEntries: new Map([
      [
        storyPast,
        [
          entry({ rev: 1, date: '2020-01-01', completed: 0, remaining: 4, state: 'New', iterationPath: past, estimate: 4, type: requirementType }),
          entry({ rev: 2, date: '2020-01-14', completed: 4, remaining: 0, state: 'Closed', iterationPath: past, estimate: 4, type: requirementType }),
        ],
      ],
      [
        storyCurrent,
        [
          entry({ rev: 1, date: yesterday, completed: 0, remaining: 10, state: 'Active', iterationPath: current, estimate: 10, type: requirementType }),
        ],
      ],
    ]),
  });
  const result = await scrum.getVelocity({ windowSize: 6 });
  const currentSprint = result.sprints.find((s) => s.sprintPath === current);
  assert.strictEqual(currentSprint.isProvisional, true);
  assert.strictEqual(result.average, 4, 'average must be over the past sprint only');
});

// --- Pure distributeStory tests: T021a, T022, T023, T023a, T023b ----------
// These exercise server/compute/velocity.js directly rather than through a
// full ScrumEngine, since the rules below are about the arithmetic itself,
// not orchestration/caching (that's T021's job, above, via the cache-key
// assertion in "a stale/incomplete index must never freeze a wrong answer").

const { distributeStory } = require('../server/compute/velocity');

suite('US1 velocity: estimate read at EACH sprint\'s own end (FR-008a-iv)');

test('a story at 5 points during sprint A and 8 during sprint B credits A against 5 and B against 8', () => {
  const shares = distributeStory({
    id: 1,
    title: 'S',
    perSprint: [
      { sprintPath: 'A', deltaCompleted: 5, totalAtEnd: 5, estimateAtEnd: 5 },
      { sprintPath: 'B', deltaCompleted: 3, totalAtEnd: 8, estimateAtEnd: 8 },
    ],
    completingSprintPath: 'B',
    finalEstimate: 8,
  });
  assert.strictEqual(shares[0].estimateAtSprintEnd, 5);
  assert.strictEqual(shares[1].estimateAtSprintEnd, 8);
});

suite('US1 velocity: re-estimate interaction (FR-008c-i through FR-008c-iv, SC-002a, SC-002d)');

test('an upward re-estimate after A closed leaves A byte-identical regardless of how large the final estimate grows', () => {
  const build = (finalEstimate) =>
    distributeStory({
      id: 2,
      title: 'S',
      perSprint: [
        { sprintPath: 'A', deltaCompleted: 3, totalAtEnd: 5, estimateAtEnd: 5 },
        { sprintPath: 'B', deltaCompleted: 2, totalAtEnd: 5, estimateAtEnd: finalEstimate },
      ],
      completingSprintPath: 'B',
      finalEstimate,
    });
  const withEight = build(8);
  const withThirteen = build(13);
  assert.strictEqual(withEight[0].points, withThirteen[0].points, "A's share must not move when the final estimate grows further");
  assert.strictEqual(withEight[0].points, 3);
});

test('a downward re-estimate below already-credited shares credits the completing sprint zero and discloses the excess', () => {
  const shares = distributeStory({
    id: 3,
    title: 'S',
    perSprint: [
      { sprintPath: 'A', deltaCompleted: 5, totalAtEnd: 5, estimateAtEnd: 5 },
      { sprintPath: 'B', deltaCompleted: 4, totalAtEnd: 9, estimateAtEnd: 9 },
      { sprintPath: 'C', deltaCompleted: 0, totalAtEnd: 9, estimateAtEnd: 6 },
    ],
    completingSprintPath: 'C',
    finalEstimate: 6, // re-estimated DOWN below the 5+4=9 already credited
  });
  assert.strictEqual(shares[0].points, 5, "A's share is untouched");
  assert.strictEqual(shares[1].points, 4, "B's share is untouched");
  const completing = shares[2];
  assert.strictEqual(completing.points, 0, 'never a negative credit');
  assert.strictEqual(completing.overDistributedBy, 3);
});

suite('US1 velocity: arithmetic edge cases (FR-008a-i, FR-008d-i, FR-008b-i)');

test('a sprint with no recorded increase credits 0 even when the story sat in it throughout', () => {
  const shares = distributeStory({
    id: 4,
    title: 'S',
    perSprint: [{ sprintPath: 'A', deltaCompleted: 0, totalAtEnd: 8, estimateAtEnd: 8 }],
    completingSprintPath: null,
    finalEstimate: 8,
  });
  assert.strictEqual(shares[0].points, 0);
});

test('an overrun across sprints is capped and the capping sprint discloses it', () => {
  const shares = distributeStory({
    id: 5,
    title: 'S',
    perSprint: [
      { sprintPath: 'A', deltaCompleted: 8, totalAtEnd: 8, estimateAtEnd: 5 }, // already reaches the full estimate here
      { sprintPath: 'B', deltaCompleted: 2, totalAtEnd: 10, estimateAtEnd: 5 }, // more "progress" after the estimate is already spent
    ],
    completingSprintPath: null,
    finalEstimate: 5,
  });
  assert.strictEqual(shares[0].points, 5);
  const total = shares.reduce((sum, s) => sum + s.points, 0);
  assert.strictEqual(total, 5, 'never more than the estimate, however much delta is reported afterwards');
  assert.strictEqual(shares[1].capped, true, 'the capping sprint discloses that IT capped');
});

suite('US1 velocity: whole-credit is decided per story, not diverted when measurable elsewhere (FR-008e-ii)');

test('measurable in one sprint but not another is NOT diverted into whole-credit', () => {
  const shares = distributeStory({
    id: 6,
    title: 'S',
    perSprint: [
      { sprintPath: 'A', deltaCompleted: 0, totalAtEnd: null, estimateAtEnd: 3 }, // no data this sprint
      { sprintPath: 'B', deltaCompleted: 3, totalAtEnd: 3, estimateAtEnd: 3 },
    ],
    completingSprintPath: 'B',
    finalEstimate: 3,
  });
  assert.strictEqual(shares[1].basis, 'measured', 'must not fall back to whole-credit when SOME sprint had real data');
});

suite('US1 velocity: whole-credit is never dropped, never credited twice (FR-008g)');

test('a story reopened and completed again still contributes its estimate exactly once', () => {
  // scrum.js picks completingSprintPath as the FIRST sprint reaching the
  // Completed category — a later reopen/re-complete never produces a SECOND
  // completingSprintPath, which is what this test pins: distributeStory
  // only ever treats ONE entry as `isCompleting`.
  const shares = distributeStory({
    id: 7,
    title: 'S',
    perSprint: [
      { sprintPath: 'A', deltaCompleted: 0, totalAtEnd: null, estimateAtEnd: 5 },
      { sprintPath: 'B', deltaCompleted: 0, totalAtEnd: null, estimateAtEnd: 5 }, // reopened, then closed again here in reality — still not `completingSprintPath`
    ],
    completingSprintPath: 'A',
    finalEstimate: 5,
  });
  const completingCount = shares.filter((s) => s.remainder).length;
  assert.strictEqual(completingCount, 1, 'exactly one sprint ever carries the completing credit');
  const total = shares.reduce((sum, s) => sum + s.points, 0);
  assert.strictEqual(total, 5, 'credited exactly once, for its full estimate');
});

suite('US1 velocity: per-sprint denominator, not a single story-wide one (FR-008d)');

test('a later sprint is computed against ITS OWN larger total; the earlier sprint keeps its own', () => {
  const shares = distributeStory({
    id: 8,
    title: 'S',
    perSprint: [
      { sprintPath: 'A', deltaCompleted: 2, totalAtEnd: 4, estimateAtEnd: 4 }, // denominator 4 at A's end
      { sprintPath: 'B', deltaCompleted: 4, totalAtEnd: 10, estimateAtEnd: 10 }, // scope grew; denominator 10 at B's end
    ],
    completingSprintPath: 'B',
    finalEstimate: 10,
  });
  assert.strictEqual(shares[0].fraction, 0.5, "A's fraction uses A's own 4, not B's later 10");
  // B is the completing sprint, so its points come from the remainder
  // (FR-008b), but its FRACTION (disclosed for transparency) is still
  // computed against its own, larger, denominator.
  assert.ok(Math.abs(shares[1].fraction - 0.4) < 1e-9, "B's fraction uses B's own 10");
});

module.exports = run;

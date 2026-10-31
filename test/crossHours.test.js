/**
 * Cross-project hours (server/crossHours.js) — the one view that deliberately
 * spans project scopes, so the properties worth pinning down are the mirror
 * image of test/projectScoping.test.js's: hours from two projects must ADD UP,
 * while still staying individually attributable to the project they came from,
 * and one unreadable project must not take the whole answer down with it.
 *
 * Offline: a fake registry hands out scopes whose revision indexes are written
 * by hand, so what's under test is the merge/attribution logic rather than
 * Azure DevOps.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { Cache } = require('../server/cache');
const { CrossHours, idsTouchedBy, windowDayKeys } = require('../server/crossHours');
const { dayKey } = require('../server/compute/timeline');

const ME = 'me@example.com';
const OTHER = 'someone.else@example.com';

const SESSION = { id: 'person-1', displayName: 'Me', uniqueName: 'Me@Example.com', pat: 'my-pat' };
/** The teammate a lead opens on the Team page: hours attributed to THEM, read
 * with the caller's token — no PAT of their own is involved (or knowable). */
const TEAMMATE = { id: 'person-2', displayName: 'Someone Else', uniqueName: 'Someone.Else@Example.com' };

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

const TODAY = dayKey(new Date());

/** A revision index entry list: [rev, completedWork, whenIso, who]. */
function revs(...tuples) {
  return tuples.map(([rev, completedWork, changedDate, changedBy]) => ({ rev, completedWork, changedDate, changedBy }));
}

/** Titles come back from a batch call on the scope's own client — faked so the
 * breakdown can assert that each row is labelled from ITS project. */
function titleClient(projectName) {
  return {
    async post(url, body) {
      return {
        value: (body.ids || []).map((id) => ({
          id,
          fields: { 'System.Title': `${projectName} item ${id}`, 'System.WorkItemType': 'Task' },
        })),
      };
    },
  };
}

/** `tracker`, when given, counts how many builds are inside a project walk at
 * the same time — the property `_start`'s queue exists to hold at one. */
function fakeScope(project, index, tracker) {
  return {
    project,
    sync: {
      revisionIndex: index,
      updatesCache: {},
      client: titleClient(project.name),
      async ensureRevisionIndex() {
        if (!tracker) return;
        tracker.inFlight += 1;
        tracker.max = Math.max(tracker.max, tracker.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        tracker.inFlight -= 1;
      },
      async ensureBoundarySeeded() {},
    },
  };
}

/** `unreadable` names projects that exist in the org but whose scope can't be
 * opened with this token — exactly what registry.getScope throws for. */
function fakeRegistry(scopes, unreadable = []) {
  const opened = [];
  return {
    /** Every {project, credentials} getScope was called with, so a test can
     * assert WHOSE token opened the scope — the viewer's, always. */
    opened,
    async getScope(project, credentials) {
      opened.push({ project, credentials });
      if (unreadable.includes(project.name)) throw new Error('no access');
      const scope = scopes.find((s) => s.project.name === project.name);
      if (!scope) throw new Error('no access');
      return scope;
    },
    retain() {
      return () => {};
    },
    list() {
      return scopes;
    },
  };
}

function buildFixture(tracker) {
  const A = { id: 'aaaa1111', name: 'ProjectA' };
  const B = { id: 'bbbb2222', name: 'ProjectB' };
  const C = { id: 'cccc3333', name: 'ProjectC' };
  const D = { id: 'dddd4444', name: 'ProjectD' };

  const indexA = new Map([
    // +3h today, by me
    [101, revs([1, 0, isoDaysAgo(2), ME], [2, 3, isoDaysAgo(0), ME])],
    // +4h today, by someone else — must not land in my total
    [102, revs([1, 0, isoDaysAgo(2), OTHER], [2, 4, isoDaysAgo(0), OTHER])],
  ]);
  const indexB = new Map([[201, revs([1, 0, isoDaysAgo(2), ME], [2, 2, isoDaysAgo(0), ME])]]);
  // Readable, but nothing of mine in it.
  const indexC = new Map([[301, revs([1, 0, isoDaysAgo(2), OTHER], [2, 9, isoDaysAgo(0), OTHER])]]);

  const scopes = [fakeScope(A, indexA, tracker), fakeScope(B, indexB, tracker), fakeScope(C, indexC, tracker)];
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azdash-crosshours-'));
  const registry = fakeRegistry(scopes, [D.name]);
  const cross = new CrossHours({
    registry,
    config: { org: 'test-org', apiVersion: '7.1' },
    cache: new Cache(cacheDir),
    listProjects: async () => [A, B, C, D],
  });
  return { cross, registry, A, B, C, D };
}

/** Drives one full build to completion — `request()` only ever kicks it off.
 * `person` defaults to the caller, which is the Dashboard's case. */
async function build(person) {
  const { cross, ...rest } = buildFixture();
  const result = await cross._start(SESSION, person || SESSION);
  return { cross, result, ...rest };
}

suite('idsTouchedBy: whose revisions count');

test('an item only ever revised by someone else is not mine', () => {
  const index = new Map([
    [1, revs([1, 2, isoDaysAgo(1), OTHER])],
    [2, revs([1, 2, isoDaysAgo(1), ME])],
  ]);
  assert.deepStrictEqual(idsTouchedBy(index, ME), [2]);
});

test('an item with an unattributable revision is kept, matching the timeline fallback', () => {
  // buildDailyHoursFromIndex counts a delta whose author is unknown rather
  // than dropping real hours; excluding those ids here would disagree with it.
  const index = new Map([[7, revs([1, 2, isoDaysAgo(1), null])]]);
  assert.deepStrictEqual(idsTouchedBy(index, ME), [7]);
});

suite('windowDayKeys: the breakdown window');

test('is 7 days ending today, in order', () => {
  const keys = windowDayKeys(new Date('2026-08-11T09:00:00Z'), 7);
  assert.strictEqual(keys.length, 7);
  assert.strictEqual(keys[6], '2026-08-11');
  assert.strictEqual(keys[0], '2026-08-05');
});

suite('the cross-project sum');

test("today's hours are the sum of every project's", async () => {
  const { result } = await build();
  assert.strictEqual(result.timeline.today.hours, 5); // 3 in A + 2 in B
});

test("another person's hours in the same project are excluded", async () => {
  const { result } = await build();
  // ProjectA's index also holds a +4h revision by someone else on item 102.
  const ids = result.timeline.breakdown[TODAY].map((e) => e.id);
  assert.ok(!ids.includes(102), 'a teammate\'s item leaked into my breakdown');
});

test('a project I logged nothing in is left out of the project list', async () => {
  const { result } = await build();
  const names = result.projects.map((p) => p.name);
  assert.deepStrictEqual(names, ['ProjectA', 'ProjectB']); // C readable but has none of mine
});

test('project totals are ordered by hours, biggest first', async () => {
  const { result } = await build();
  assert.deepStrictEqual(result.projects, [
    { name: 'ProjectA', hours: 3 },
    { name: 'ProjectB', hours: 2 },
  ]);
});

suite('the breakdown stays attributable');

test('every row names the project its item lives in', async () => {
  const { result } = await build();
  const byId = new Map(result.timeline.breakdown[TODAY].map((e) => [e.id, e]));
  assert.strictEqual(byId.get(101).project, 'ProjectA');
  assert.strictEqual(byId.get(201).project, 'ProjectB');
});

test('titles are read from each item\'s own project', async () => {
  const { result } = await build();
  const byId = new Map(result.timeline.breakdown[TODAY].map((e) => [e.id, e]));
  assert.strictEqual(byId.get(101).title, 'ProjectA item 101');
  assert.strictEqual(byId.get(201).title, 'ProjectB item 201');
});

test('rows are sorted by hours within the day', async () => {
  const { result } = await build();
  const hours = result.timeline.breakdown[TODAY].map((e) => e.hours);
  assert.deepStrictEqual(hours, [3, 2]);
});

suite('a project that cannot be read');

test('is reported as skipped rather than failing the whole build', async () => {
  const { result } = await build();
  assert.deepStrictEqual(result.skipped, [{ name: 'ProjectD', reason: 'no-access' }]);
});

test('does not stop the readable projects from counting', async () => {
  const { result } = await build();
  assert.strictEqual(result.timeline.today.hours, 5);
  assert.strictEqual(result.projectsScanned, 4);
});

suite("a teammate's hours (the Team page card)");

test('are attributed to the teammate, not to whoever asked', async () => {
  const { result } = await build(TEAMMATE);
  // The other person's revisions: +4h in ProjectA (item 102), +9h in ProjectC
  // (item 301). None of MY 3+2 may appear.
  assert.strictEqual(result.timeline.today.hours, 13);
  const ids = result.timeline.breakdown[TODAY].map((e) => e.id).sort();
  assert.deepStrictEqual(ids, [102, 301]);
});

test('name the teammate in the payload, and say it is not the caller', async () => {
  const { result } = await build(TEAMMATE);
  assert.deepStrictEqual(result.person, { id: 'person-2', displayName: 'Someone Else' });
  assert.strictEqual(result.self, false);
});

test('a self build still marks itself as the caller', async () => {
  const { result } = await build();
  assert.strictEqual(result.self, true);
  assert.strictEqual(result.person.id, SESSION.id);
});

test('cover only the projects the teammate actually logged in', async () => {
  const { result } = await build(TEAMMATE);
  assert.deepStrictEqual(result.projects, [
    { name: 'ProjectC', hours: 9 },
    { name: 'ProjectA', hours: 4 },
  ]);
});

test("every scope is opened with the VIEWER's token and identity", async () => {
  // The person whose hours these are has no PAT here and never could — a
  // teammate's token is not the caller's to use. Swapping the identity would
  // also mis-record the owner of an elected user read token (server/scopes.js).
  const { registry } = await build(TEAMMATE);
  assert.ok(registry.opened.length > 0);
  for (const call of registry.opened) {
    assert.strictEqual(call.credentials.pat, SESSION.pat);
    assert.strictEqual(call.credentials.identity.id, SESSION.id);
    assert.strictEqual(call.credentials.identity.uniqueName, SESSION.uniqueName);
  }
});

suite('006-linked-identity-aliases (T034): the identity set, not just the primary, is summed');

const OLD_IDENTITY = 'alex.k@legacy-example.onmicrosoft.com';
const NEW_IDENTITY = 'alex.k@example.dev';
const MIGRATED_PERSON = {
  id: 'person-3',
  displayName: 'Migrated Person',
  uniqueName: NEW_IDENTITY,
  identities: { keys: new Set([NEW_IDENTITY, OLD_IDENTITY]) },
};

/** Same shape as buildFixture, but ProjectA's history was logged under the
 * OLD identity and ProjectB's under the NEW one — the exact split a
 * migration produces (old work stays stamped with the retired account,
 * new work lands under the new one). */
function buildMigratedFixture() {
  const A = { id: 'aaaa1111', name: 'ProjectA' };
  const B = { id: 'bbbb2222', name: 'ProjectB' };

  const indexA = new Map([[101, revs([1, 0, isoDaysAgo(2), OLD_IDENTITY], [2, 3, isoDaysAgo(0), OLD_IDENTITY])]]);
  const indexB = new Map([[201, revs([1, 0, isoDaysAgo(2), NEW_IDENTITY], [2, 2, isoDaysAgo(0), NEW_IDENTITY])]]);
  const otherIndex = new Map([[301, revs([1, 0, isoDaysAgo(2), OTHER], [2, 9, isoDaysAgo(0), OTHER])]]);
  const C = { id: 'cccc3333', name: 'ProjectC' };

  const scopes = [fakeScope(A, indexA), fakeScope(B, indexB), fakeScope(C, otherIndex)];
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azdash-crosshours-linked-'));
  const registry = fakeRegistry(scopes);
  const cross = new CrossHours({
    registry,
    config: { org: 'test-org', apiVersion: '7.1' },
    cache: new Cache(cacheDir),
    listProjects: async () => [A, B, C],
  });
  return { cross, A, B, C };
}

test('idsTouchedBy with a Set matches a revision by EITHER identity', () => {
  const index = new Map([
    [1, revs([1, 2, isoDaysAgo(1), OLD_IDENTITY])],
    [2, revs([1, 2, isoDaysAgo(1), NEW_IDENTITY])],
    [3, revs([1, 2, isoDaysAgo(1), OTHER])],
  ]);
  const keys = new Set([OLD_IDENTITY, NEW_IDENTITY]);
  assert.deepStrictEqual(idsTouchedBy(index, keys), [1, 2]);
});

test('a project logged entirely under the OLD identity still counts toward the total', async () => {
  const { cross } = buildMigratedFixture();
  const result = await cross._start(SESSION, MIGRATED_PERSON);
  assert.strictEqual(result.timeline.today.hours, 5); // 3 (old, ProjectA) + 2 (new, ProjectB)
});

test('both projects appear in the per-project breakdown, each under its own name', async () => {
  const { cross } = buildMigratedFixture();
  const result = await cross._start(SESSION, MIGRATED_PERSON);
  const names = result.projects.map((p) => p.name).sort();
  assert.deepStrictEqual(names, ['ProjectA', 'ProjectB']);
});

test('a person with no identities attached falls back to the single uniqueName form unchanged', async () => {
  const { cross } = buildMigratedFixture();
  // No `.identities` at all — only ProjectB's NEW_IDENTITY-authored hours
  // should count, matching pre-widening behaviour exactly.
  const result = await cross._start(SESSION, { id: 'person-3', displayName: 'X', uniqueName: NEW_IDENTITY });
  assert.strictEqual(result.timeline.today.hours, 2);
});

suite('caching');

test('a built result is served from cache, and marked fresh', async () => {
  const { cross } = await build();
  const answer = cross.request(SESSION);
  assert.strictEqual(answer.status, 'ready');
  assert.strictEqual(answer.stale, false);
  assert.strictEqual(answer.timeline.today.hours, 5);
});

test('nothing cached yet answers building rather than blocking', () => {
  const { cross } = buildFixture();
  const answer = cross.request(SESSION);
  assert.strictEqual(answer.status, 'building');
});

test("one person's cached result is never served as another's", async () => {
  const { cross } = await build(TEAMMATE);
  // The teammate's answer exists; mine does not, and must not be answered
  // with theirs.
  assert.strictEqual(cross.request(SESSION, TEAMMATE).timeline.today.hours, 13);
  assert.strictEqual(cross.request(SESSION).status, 'building');
});

suite('builds are serialised');

test('two people asked for at once are walked one after the other', async () => {
  // The Team page can expand several members at once; two concurrent walks
  // would contend for the same token's ADO rate budget.
  const tracker = { inFlight: 0, max: 0 };
  const { cross } = buildFixture(tracker);
  await Promise.all([cross._start(SESSION), cross._start(SESSION, TEAMMATE)]);
  assert.strictEqual(tracker.max, 1);
});

test('a failed build does not sink the one queued behind it', async () => {
  const { cross } = buildFixture();
  cross.listProjects = async () => {
    cross.listProjects = async () => [{ id: 'aaaa1111', name: 'ProjectA' }];
    throw new Error('ADO is down');
  };
  const [failed, after] = await Promise.all([cross._start(SESSION), cross._start(SESSION, TEAMMATE)]);
  assert.strictEqual(failed, null);
  assert.ok(after, 'the queued build was dropped when the one before it failed');
  assert.strictEqual(after.timeline.today.hours, 4); // the teammate's ProjectA hours
});

module.exports = run;

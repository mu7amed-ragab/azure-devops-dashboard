/**
 * A1 (2026-08-14 review, plan.md Track A): server/ado/capacity.js's `hours`
 * used to be ADO's raw per-day `capacityPerDay` rate, taken as-is and later
 * divided into a whole-sprint logged-hours total by capacityRollup.js — a
 * unit mismatch that inflated utilisation ~10x. The fix multiplies that rate
 * by the sprint's own working days AS ADO RECORDS THEM for the team
 * (`work/teamsettings`'s `workingDays`, `.../teamdaysoff`, and each
 * capacity row's own `daysOff`) — arithmetic over recorded values, never an
 * assumed pattern (FR-021a-ii's no-fallback rule is about NOT guessing a
 * pattern, not about refusing to count a real one).
 */

const { suite, test, run, assert } = require('./harness');
const { createFakeClient } = require('./fixtures/fakeClient');
const {
  fetchTeamCapacities,
  fetchAllCapacities,
  fetchTeamWorkingDays,
  fetchTeamDaysOff,
} = require('../server/ado/capacity');
const { sprintWorkingDayCount } = require('../server/compute/capacityRollup');

const SPRINT = { startDate: '2026-02-02', finishDate: '2026-02-13' }; // Mon 2/2 - Fri 2/13, two full Mon-Fri weeks = 10 working days

function capacityRow(uniqueName, displayName, capacityPerDay, daysOff = []) {
  return { teamMember: { uniqueName, displayName }, activities: [{ name: 'Development', capacityPerDay }], daysOff };
}

suite('sprintWorkingDayCount: pure arithmetic over a real pattern + real off-ranges');

test('a plain Mon-Fri team over a 2-week sprint counts 10 working days', () => {
  const workingDays = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
  assert.strictEqual(sprintWorkingDayCount(SPRINT.startDate, SPRINT.finishDate, workingDays, []), 10);
});

test('a team day off inside the sprint reduces the count by one', () => {
  const workingDays = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
  const offRanges = [{ start: '2026-02-05', end: '2026-02-05' }]; // one Thursday
  assert.strictEqual(sprintWorkingDayCount(SPRINT.startDate, SPRINT.finishDate, workingDays, offRanges), 9);
});

test('overlapping team + person days off do not double-subtract (a Set of dates, not a sum of ranges)', () => {
  const workingDays = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
  const offRanges = [
    { start: '2026-02-05', end: '2026-02-05' },
    { start: '2026-02-04', end: '2026-02-06' }, // spans the same Thursday
  ];
  assert.strictEqual(sprintWorkingDayCount(SPRINT.startDate, SPRINT.finishDate, workingDays, offRanges), 7, 'Wed/Thu/Fri of week 1 excluded once each, not twice');
});

test('a weekend inside the range is never counted regardless of days-off data', () => {
  const workingDays = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
  assert.strictEqual(sprintWorkingDayCount('2026-02-07', '2026-02-08', workingDays, []), 0); // Sat/Sun
});

test('an unknown (empty/absent) working-day pattern returns null, never a guessed count', () => {
  assert.strictEqual(sprintWorkingDayCount(SPRINT.startDate, SPRINT.finishDate, new Set(), []), null);
  assert.strictEqual(sprintWorkingDayCount(SPRINT.startDate, SPRINT.finishDate, null, []), null);
});

suite('server/ado/capacity.js A1: fetchTeamCapacities multiplies the recorded rate by the recorded working-day count');

test('a 6h/day member over a 10-working-day sprint reports 60h, not 6h', async () => {
  const client = createFakeClient({
    project: 'P',
    teams: [{ id: 't1', name: 'Platform' }],
    capacities: { 'Platform::iter1': { value: [capacityRow('alice@x.com', 'Alice', 6)] } },
    teamSettings: { Platform: { workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] } },
    teamDaysOff: { 'Platform::iter1': { daysOff: [] } },
  });
  const records = await fetchTeamCapacities(client, { id: 't1', name: 'Platform' }, 'iter1', SPRINT);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].hours, 60, '6h/day * 10 working days = 60h, not the bare 6h/day rate');
});

test('a team day off reduces the total proportionally', async () => {
  const client = createFakeClient({
    project: 'P',
    teams: [{ id: 't1', name: 'Platform' }],
    capacities: { 'Platform::iter1': { value: [capacityRow('alice@x.com', 'Alice', 6)] } },
    teamSettings: { Platform: { workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] } },
    teamDaysOff: { 'Platform::iter1': { daysOff: [{ start: '2026-02-05', end: '2026-02-05' }] } },
  });
  const records = await fetchTeamCapacities(client, { id: 't1', name: 'Platform' }, 'iter1', SPRINT);
  assert.strictEqual(records[0].hours, 54, '6h/day * 9 working days after the team day off');
});

test("a member's own days off reduce only THEIR total, not their teammates'", async () => {
  const client = createFakeClient({
    project: 'P',
    teams: [{ id: 't1', name: 'Platform' }],
    capacities: {
      'Platform::iter1': {
        value: [
          capacityRow('alice@x.com', 'Alice', 6, [{ start: '2026-02-05', end: '2026-02-06' }]), // 2 days off
          capacityRow('bob@x.com', 'Bob', 6, []),
        ],
      },
    },
    teamSettings: { Platform: { workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] } },
    teamDaysOff: { 'Platform::iter1': { daysOff: [] } },
  });
  const records = await fetchTeamCapacities(client, { id: 't1', name: 'Platform' }, 'iter1', SPRINT);
  const alice = records.find((r) => r.personKey === 'alice@x.com');
  const bob = records.find((r) => r.personKey === 'bob@x.com');
  assert.strictEqual(alice.hours, 48, "6h/day * 8 working days after Alice's own 2 days off");
  assert.strictEqual(bob.hours, 60, "Bob's total is unaffected by Alice's days off");
});

test('an unknown team working-day pattern drops that allocation entirely — absent, never guessed', async () => {
  const client = createFakeClient({
    project: 'P',
    teams: [{ id: 't1', name: 'Platform' }],
    capacities: { 'Platform::iter1': { value: [capacityRow('alice@x.com', 'Alice', 6)] } },
    teamSettings: {}, // no working-day pattern configured for this team
    teamDaysOff: { 'Platform::iter1': { daysOff: [] } },
  });
  const records = await fetchTeamCapacities(client, { id: 't1', name: 'Platform' }, 'iter1', SPRINT);
  assert.deepStrictEqual(records, [], 'no fabricated hours when the working-day basis is unknown (FR-021a-ii)');
});

test('a 404 on /capacities itself is still "no capacity recorded" — unrelated to the working-day fetches', async () => {
  const client = createFakeClient({
    project: 'P',
    teams: [{ id: 't1', name: 'Platform' }],
    capacities: {}, // no capacities recorded for this team/iteration at all
  });
  const records = await fetchTeamCapacities(client, { id: 't1', name: 'Platform' }, 'iter1', SPRINT);
  assert.deepStrictEqual(records, []);
});

test('fetchAllCapacities aggregates across every team, each keeping its own working-day basis', async () => {
  const client = createFakeClient({
    project: 'P',
    teams: [{ id: 't1', name: 'Platform' }, { id: 't2', name: 'Payments' }],
    capacities: {
      'Platform::iter1': { value: [capacityRow('alice@x.com', 'Alice', 4)] },
      'Payments::iter1': { value: [capacityRow('alice@x.com', 'Alice', 2)] },
    },
    teamSettings: {
      Platform: { workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] },
      Payments: { workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] },
    },
    teamDaysOff: {
      'Platform::iter1': { daysOff: [] },
      'Payments::iter1': { daysOff: [] },
    },
  });
  const records = await fetchAllCapacities(client, 'proj1', 'iter1', SPRINT);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records.reduce((s, r) => s + r.hours, 0), 60, '(4+2)h/day * 10 working days, summed across both teams');
});

suite('fetchTeamWorkingDays / fetchTeamDaysOff: direct fetch behavior');

test('fetchTeamWorkingDays lowercases day names into a Set', async () => {
  const client = createFakeClient({ project: 'P', teamSettings: { Platform: { workingDays: ['Monday', 'Tuesday'] } } });
  const days = await fetchTeamWorkingDays(client, 'Platform');
  assert.deepStrictEqual([...days].sort(), ['monday', 'tuesday']);
});

test('fetchTeamWorkingDays returns null for a 404 and for an empty array', async () => {
  const client = createFakeClient({ project: 'P', teamSettings: {} });
  assert.strictEqual(await fetchTeamWorkingDays(client, 'Nobody'), null);
  const client2 = createFakeClient({ project: 'P', teamSettings: { Empty: { workingDays: [] } } });
  assert.strictEqual(await fetchTeamWorkingDays(client2, 'Empty'), null);
});

test('fetchTeamDaysOff returns [] for a 404, the real array otherwise', async () => {
  const client = createFakeClient({ project: 'P', teamDaysOff: {} });
  assert.deepStrictEqual(await fetchTeamDaysOff(client, 'Platform', 'iter1'), []);
  const client2 = createFakeClient({ project: 'P', teamDaysOff: { 'Platform::iter1': { daysOff: [{ start: 'a', end: 'b' }] } } });
  assert.deepStrictEqual(await fetchTeamDaysOff(client2, 'Platform', 'iter1'), [{ start: 'a', end: 'b' }]);
});

module.exports = run;

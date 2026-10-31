const assert = require('assert');
const { suite, test, run } = require('./harness');
const { buildTimeline, buildDailyHoursFromIndex, matchesPersonKey } = require('../server/compute/timeline');

suite('buildTimeline: weeklyAverage scaffold');

test('weeklyAverage exists on an empty timeline', () => {
  const timeline = buildTimeline(new Map(), new Date('2026-08-25T00:00:00Z'));
  assert.ok(timeline.weeklyAverage, 'expected buildTimeline() to return a weeklyAverage field');
});

// August 2026: Sun 23, Mon 24, Tue 25, Wed 26, Thu 27, Fri 28, Sat 29, Sun 30.

suite('buildTimeline: weeklyAverage window + divisor (US1)');

test('mid-week (Tuesday): sums Sun+Mon+Tue and divides by 3', () => {
  const daily = new Map([
    ['2026-08-23', 6], // Sun
    ['2026-08-24', 7], // Mon
    ['2026-08-25', 5], // Tue
  ]);
  const timeline = buildTimeline(daily, new Date('2026-08-25T12:00:00Z'));
  assert.strictEqual(timeline.weeklyAverage.weekStart, '2026-08-23');
  assert.strictEqual(timeline.weeklyAverage.daysElapsed, 3);
  assert.strictEqual(timeline.weeklyAverage.hoursPerDay, 6);
});

test('Sunday only: divisor is 1, not 0', () => {
  const daily = new Map([['2026-08-23', 4]]); // Sun
  const timeline = buildTimeline(daily, new Date('2026-08-23T09:00:00Z'));
  assert.strictEqual(timeline.weeklyAverage.daysElapsed, 1);
  assert.strictEqual(timeline.weeklyAverage.hoursPerDay, 4);
});

test('Friday/Saturday: window stays on the just-completed Sun-Thu week', () => {
  const daily = new Map([
    ['2026-08-23', 6], // Sun
    ['2026-08-24', 6], // Mon
    ['2026-08-25', 6], // Tue
    ['2026-08-26', 6], // Wed
    ['2026-08-27', 6], // Thu
  ]);
  const friday = buildTimeline(daily, new Date('2026-08-28T09:00:00Z'));
  assert.strictEqual(friday.weeklyAverage.weekStart, '2026-08-23');
  assert.strictEqual(friday.weeklyAverage.daysElapsed, 5);
  assert.strictEqual(friday.weeklyAverage.hoursPerDay, 6);

  const saturday = buildTimeline(daily, new Date('2026-08-29T09:00:00Z'));
  assert.strictEqual(saturday.weeklyAverage.weekStart, '2026-08-23');
  assert.strictEqual(saturday.weeklyAverage.daysElapsed, 5);
  assert.strictEqual(saturday.weeklyAverage.hoursPerDay, 6);
});

suite('buildTimeline: 8-hour daily cap (US2)');

test('a day over 8h contributes only 8h to the sum', () => {
  const daily = new Map([
    ['2026-08-24', 10], // Mon — over the cap
    ['2026-08-25', 6], // Tue
  ]);
  const timeline = buildTimeline(daily, new Date('2026-08-25T12:00:00Z'));
  // (8 capped + 6) / 3 elapsed days (Sun=0, Mon=10->8, Tue=6)
  assert.strictEqual(timeline.weeklyAverage.hoursPerDay, 4.67);
});

test('a day at exactly 8h contributes its full 8h (cap does not reduce it)', () => {
  const daily = new Map([['2026-08-23', 8]]); // Sun
  const timeline = buildTimeline(daily, new Date('2026-08-23T09:00:00Z'));
  assert.strictEqual(timeline.weeklyAverage.hoursPerDay, 8);
});

test('a 0-hour day inside the window still counts toward the divisor', () => {
  const daily = new Map([
    ['2026-08-23', 6], // Sun
    // Monday: nothing logged
    ['2026-08-25', 6], // Tue
  ]);
  const timeline = buildTimeline(daily, new Date('2026-08-25T12:00:00Z'));
  assert.strictEqual(timeline.weeklyAverage.daysElapsed, 3);
  assert.strictEqual(timeline.weeklyAverage.hoursPerDay, 4); // (6+0+6)/3
});

suite('buildTimeline: weekly utilization percentage (US3)');

test('6.0 hrs/day averages to 75% utilization', () => {
  const daily = new Map([
    ['2026-08-23', 6],
    ['2026-08-24', 7],
    ['2026-08-25', 5],
  ]);
  const timeline = buildTimeline(daily, new Date('2026-08-25T12:00:00Z'));
  assert.strictEqual(timeline.weeklyAverage.hoursPerDay, 6);
  assert.strictEqual(timeline.weeklyAverage.utilizationPct, 75);
});

test('8.0+ hrs/day caps utilization at 100%, never above', () => {
  const daily = new Map([['2026-08-23', 12]]); // logged 12, capped to 8 by the average itself
  const timeline = buildTimeline(daily, new Date('2026-08-23T09:00:00Z'));
  assert.strictEqual(timeline.weeklyAverage.hoursPerDay, 8);
  assert.strictEqual(timeline.weeklyAverage.utilizationPct, 100);
});

test('no hours logged this week yields 0% utilization, not an error', () => {
  const timeline = buildTimeline(new Map(), new Date('2026-08-25T12:00:00Z'));
  assert.strictEqual(timeline.weeklyAverage.hoursPerDay, 0);
  assert.strictEqual(timeline.weeklyAverage.utilizationPct, 0);
});

suite('006-linked-identity-aliases (T015): matchesPersonKey / buildDailyHoursFromIndex over a Set of identities');

test('matchesPersonKey: no key given matches anything', () => {
  assert.strictEqual(matchesPersonKey(null, 'anyone@x'), true);
});

test('matchesPersonKey: a plain string key matches only itself (unchanged single-identity behaviour)', () => {
  assert.strictEqual(matchesPersonKey('a@x', 'a@x'), true);
  assert.strictEqual(matchesPersonKey('a@x', 'b@y'), false);
});

test('matchesPersonKey: a Set key matches any member', () => {
  const keys = new Set(['a@x', 'b@y']);
  assert.strictEqual(matchesPersonKey(keys, 'a@x'), true);
  assert.strictEqual(matchesPersonKey(keys, 'b@y'), true);
  assert.strictEqual(matchesPersonKey(keys, 'c@z'), false);
});

test('buildDailyHoursFromIndex counts a revision by EITHER identity, once each', () => {
  // Item 1: two revisions, one authored by each of the person's two
  // identities (an "old account did some work before the migration, new
  // account did more after" history).
  const index = new Map([
    [
      1,
      [
        { rev: 1, completedWork: 2, changedDate: '2026-08-24T10:00:00Z', changedBy: 'a@x' },
        { rev: 2, completedWork: 5, changedDate: '2026-08-25T10:00:00Z', changedBy: 'b@y' },
      ],
    ],
  ]);
  const keys = new Set(['a@x', 'b@y']);
  const { daily } = buildDailyHoursFromIndex(index, [1], {}, keys);
  assert.strictEqual(daily.get('2026-08-24'), 2, 'the first identity\'s delta is counted');
  assert.strictEqual(daily.get('2026-08-25'), 3, 'the second identity\'s delta (5-2) is counted, not double-counted');
  // Total across both days equals the sum of what each identity logged
  // separately — 2 + 3 = 5, matching the final completedWork value exactly
  // (FR-007: no hour counted twice, none dropped).
  const total = [...daily.values()].reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 5);
});

test('buildDailyHoursFromIndex: a revision by a THIRD party (not in the set) is excluded', () => {
  const index = new Map([
    [
      1,
      [
        { rev: 1, completedWork: 2, changedDate: '2026-08-24T10:00:00Z', changedBy: 'a@x' },
        { rev: 2, completedWork: 9, changedDate: '2026-08-25T10:00:00Z', changedBy: 'teammate@z' },
      ],
    ],
  ]);
  const keys = new Set(['a@x', 'b@y']);
  const { daily } = buildDailyHoursFromIndex(index, [1], {}, keys);
  assert.strictEqual(daily.get('2026-08-24'), 2);
  assert.strictEqual(daily.has('2026-08-25'), false, "the teammate's delta must not land in this person's total");
});

test('a single-identity set behaves exactly like the pre-widening string key', () => {
  const index = new Map([[1, [{ rev: 1, completedWork: 3, changedDate: '2026-08-24T10:00:00Z', changedBy: 'a@x' }]]]);
  const withString = buildDailyHoursFromIndex(index, [1], {}, 'a@x');
  const withSet = buildDailyHoursFromIndex(index, [1], {}, new Set(['a@x']));
  assert.deepStrictEqual([...withString.daily], [...withSet.daily]);
});

module.exports = run;

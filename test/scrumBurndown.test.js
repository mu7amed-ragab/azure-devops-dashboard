/** US4: burndown — one point per day, actuals stop at today, untracked state. */

const { suite, test, run, assert } = require('./harness');
const { buildBurndown, dateRange } = require('../server/compute/burndown');

suite('US4 burndown: one point per day (FR-034)');

test('a one-day sprint yields exactly one point', () => {
  const dates = dateRange('2026-01-05', '2026-01-05');
  assert.deepStrictEqual(dates, ['2026-01-05']);
});

test('a multi-month sprint yields one point per real calendar day', () => {
  const dates = dateRange('2026-01-01', '2026-03-01');
  assert.strictEqual(dates.length, 60);
});

suite('US4 burndown: actuals stop at today (FR-031)');

test('an in-progress sprint reports null, not 0, for days beyond today', () => {
  const dates = dateRange('2026-01-01', '2026-01-10');
  const remaining = dates.map((_, i) => 100 - i * 10);
  const result = buildBurndown(dates, remaining, true, '2026-01-05');
  assert.strictEqual(result.todayIndex, 4);
  for (let i = 0; i <= 4; i++) assert.strictEqual(result.points[i].remaining, remaining[i]);
  for (let i = 5; i < dates.length; i++) assert.strictEqual(result.points[i].remaining, null, `day ${i} is beyond today`);
});

suite('US4 burndown: ideal line spans the sprint (FR-030)');

test('the ideal line starts at the actual starting total and reaches 0 at the end', () => {
  const dates = dateRange('2026-01-01', '2026-01-05');
  const remaining = [40, 30, 20, 10, 0];
  const result = buildBurndown(dates, remaining, true, '2026-01-05');
  assert.strictEqual(result.points[0].ideal, 40);
  assert.strictEqual(result.points[result.points.length - 1].ideal, 0);
});

suite('US4 burndown: a mid-sprint rise is data, never smoothed (FR-032)');

test('a scope addition appears as an actual rise in the series', () => {
  const dates = dateRange('2026-01-01', '2026-01-04');
  const remaining = [40, 35, 50, 45]; // rose on day 3
  const result = buildBurndown(dates, remaining, true, '2026-01-04');
  assert.strictEqual(result.points[2].remaining, 50, 'the rise is preserved, not smoothed away');
});

suite('US4 burndown: not tracked at all (FR-033)');

test('a project recording no remaining-work values reports tracked:false, not a zero series', () => {
  const dates = dateRange('2026-01-01', '2026-01-05');
  const result = buildBurndown(dates, [0, 0, 0, 0, 0], false, '2026-01-05');
  assert.strictEqual(result.tracked, false);
  assert.deepStrictEqual(result.points, []);
});

module.exports = run;

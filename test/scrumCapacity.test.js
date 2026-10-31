/** US3: capacity rollup — summing, unknown kinds, bands, off-roster. */

const { suite, test, run, assert } = require('./harness');
const { rollupUtilisation, availableTimeFor, bandOf } = require('../server/compute/capacityRollup');

const ROSTER = [
  { personKey: 'a@x.com', displayName: 'Alice' },
  { personKey: 'b@x.com', displayName: 'Bob' },
];

suite('US3 capacity: distinct-team records are summed (FR-021a-iii, SC-006b)');

test('two records for the same person from two different teams sum, breakdown intact', () => {
  const records = [
    { teamId: 't1', teamName: 'Platform', personKey: 'a@x.com', displayName: 'Alice', hours: 24 },
    { teamId: 't2', teamName: 'Payments', personKey: 'a@x.com', displayName: 'Alice', hours: 16 },
  ];
  const { members } = rollupUtilisation(ROSTER, records, new Map());
  const alice = members.find((m) => m.personKey === 'a@x.com');
  assert.strictEqual(alice.available.status, 'known');
  assert.strictEqual(alice.available.hours, 40);
  assert.strictEqual(alice.available.allocations.length, 2);
});

suite('US3 capacity: no proxy of any kind (FR-021a-ii, SC-006a)');

test('a person with nothing recorded is not-recorded, never defaulted', () => {
  const { members } = rollupUtilisation(ROSTER, [], new Map());
  const bob = members.find((m) => m.personKey === 'b@x.com');
  assert.strictEqual(bob.available.status, 'not-recorded');
  assert.strictEqual(bob.available.hours, null);
  assert.strictEqual(bob.utilisation, null);
  assert.strictEqual(bob.band, null);
});

suite('US3 capacity: unknown kinds and conflicts (FR-021a-iv, FR-023a)');

test('same-team disagreeing records are not-additive and name their conflicts', () => {
  const records = [
    { teamId: 't1', teamName: 'Platform', personKey: 'a@x.com', displayName: 'Alice', hours: 24 },
    { teamId: 't1', teamName: 'Platform', personKey: 'a@x.com', displayName: 'Alice', hours: 30 },
  ];
  const av = availableTimeFor(records);
  assert.strictEqual(av.status, 'not-additive');
  assert.strictEqual(av.hours, null);
  assert.strictEqual(av.conflicts.length, 2);
});

suite('US3 capacity: band boundaries (FR-024, FR-024a, SC-006c)');

test('boundary values land exactly where the spec draws the line', () => {
  assert.strictEqual(bandOf(0.7), 'under');
  assert.strictEqual(bandOf(0.71), 'normal');
  assert.strictEqual(bandOf(1.09), 'normal');
  assert.strictEqual(bandOf(1.1), 'over');
  assert.strictEqual(bandOf(null), null, 'unknown availability is never defaulted to normal');
});

test('an implausibly large total is surfaced as recorded, never capped (FR-021a-vi)', () => {
  const records = [{ teamId: 't1', teamName: 'X', personKey: 'a@x.com', displayName: 'Alice', hours: 999 }];
  const av = availableTimeFor(records);
  assert.strictEqual(av.hours, 999);
});

suite('US3 capacity: off-roster (FR-026a, FR-026b, SC-015)');

test('a person who logged time but is absent from the roster is named, never folded into members/summary', () => {
  const logged = new Map([['c@x.com', 5]]);
  const { members, summary, offRoster } = rollupUtilisation(ROSTER, [], logged);
  assert.strictEqual(members.some((m) => m.personKey === 'c@x.com'), false);
  assert.strictEqual(offRoster.length, 1);
  assert.strictEqual(offRoster[0].personKey, 'c@x.com');
  assert.strictEqual(offRoster[0].loggedHours, 5);
  assert.strictEqual(summary.membersWithKnownAvailability + summary.membersExcluded, ROSTER.length, 'off-roster never inflates the roster-based summary');
});

test('an empty offRoster produces no disclosure at all', () => {
  const { offRoster } = rollupUtilisation(ROSTER, [], new Map());
  assert.deepStrictEqual(offRoster, []);
});

suite('US3 capacity: members with no logged time (FR-022)');

test('a member who logged nothing appears at zero, never omitted', () => {
  const { members } = rollupUtilisation(ROSTER, [], new Map());
  assert.strictEqual(members.length, ROSTER.length);
  assert.ok(members.every((m) => m.loggedHours === 0));
});

module.exports = run;

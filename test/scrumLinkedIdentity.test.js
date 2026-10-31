/**
 * 006-linked-identity-aliases (T030, US2 scenario 2): a migrated Scrum
 * roster member must appear as ONE utilisation row, with their logged
 * hours summed across every identity in their set — not split across two
 * personKeys, and not double-counted as a phantom off-roster contributor
 * under their retired identity's raw address.
 *
 * Exercises `ScrumEngine._mergeLinkedIdentityHours` directly against a
 * minimal fake `sync` (just `getIdentitySetForEmail`), rather than
 * standing up a full sprint/capacity fixture — the merge step is a small,
 * independently testable unit ahead of `rollupUtilisation`, which is
 * already covered on its own in test/scrumCapacity.test.js.
 */

const { suite, test, run, assert } = require('./harness');
const { ScrumEngine } = require('../server/scrum');
const { buildIdentitySet } = require('../server/identitySet');

const ROSTER = [
  { personKey: 'alex.k@example.dev', displayName: 'Alex Karim' },
  { personKey: 'teammate@x.com', displayName: 'Teammate' },
];

/** A fake `sync` exposing only what `_mergeLinkedIdentityHours` reads. */
function fakeScrumEngine(identitySetsByEmail) {
  return {
    sync: {
      async getIdentitySetForEmail(email) {
        return identitySetsByEmail[email] || buildIdentitySet({ id: email, uniqueName: email }, []);
      },
    },
  };
}

suite('006-linked-identity-aliases (T030): _mergeLinkedIdentityHours');

test('a single-identity roster member is untouched — the common case', async () => {
  const self = fakeScrumEngine({});
  const hours = new Map([['teammate@x.com', 5]]);
  const merged = await ScrumEngine.prototype._mergeLinkedIdentityHours.call(self, ROSTER, hours);
  assert.strictEqual(merged.get('teammate@x.com'), 5);
  assert.strictEqual(merged.size, 1);
});

test('a migrated member\'s hours under BOTH identities are summed onto their roster personKey', async () => {
  const primary = { id: 'new-id', displayName: 'Alex Karim', uniqueName: 'alex.k@example.dev' };
  const linked = { id: 'old-id', displayName: 'Alex Karim', uniqueName: 'alex.k@legacy-example.onmicrosoft.com' };
  const self = fakeScrumEngine({
    'alex.k@example.dev': buildIdentitySet(primary, [linked]),
  });
  const hours = new Map([
    ['alex.k@example.dev', 3],
    ['alex.k@legacy-example.onmicrosoft.com', 4],
  ]);
  const merged = await ScrumEngine.prototype._mergeLinkedIdentityHours.call(self, ROSTER, hours);
  assert.strictEqual(merged.get('alex.k@example.dev'), 7, 'summed: 3 + 4');
});

test('the retired identity\'s key is REMOVED from the map, not left at its old value', async () => {
  // If left present, rollupUtilisation's off-roster fold would show the SAME
  // hours a second time under the retired identity's raw address, since
  // that key is not itself in rosterKeys.
  const primary = { id: 'new-id', displayName: 'Alex Karim', uniqueName: 'alex.k@example.dev' };
  const linked = { id: 'old-id', displayName: 'Alex Karim', uniqueName: 'alex.k@legacy-example.onmicrosoft.com' };
  const self = fakeScrumEngine({
    'alex.k@example.dev': buildIdentitySet(primary, [linked]),
  });
  const hours = new Map([
    ['alex.k@example.dev', 3],
    ['alex.k@legacy-example.onmicrosoft.com', 4],
  ]);
  const merged = await ScrumEngine.prototype._mergeLinkedIdentityHours.call(self, ROSTER, hours);
  assert.strictEqual(merged.has('alex.k@legacy-example.onmicrosoft.com'), false, 'no phantom off-roster row left behind');
});

test('an empty roster short-circuits without calling getIdentitySetForEmail at all', async () => {
  let called = false;
  const self = {
    sync: {
      async getIdentitySetForEmail() {
        called = true;
        return buildIdentitySet({ id: 'x', uniqueName: 'x' }, []);
      },
    },
  };
  const hours = new Map([['a@x', 1]]);
  const merged = await ScrumEngine.prototype._mergeLinkedIdentityHours.call(self, [], hours);
  assert.strictEqual(called, false);
  assert.strictEqual(merged.get('a@x'), 1, 'the map is returned unchanged');
});

test('a linked identity with zero hours logged adds nothing and is left alone', async () => {
  const primary = { id: 'new-id', displayName: 'X', uniqueName: 'new@x' };
  const linked = { id: 'old-id', displayName: 'X', uniqueName: 'old@x' };
  const self = fakeScrumEngine({ 'new@x': buildIdentitySet(primary, [linked]) });
  const hours = new Map([['new@x', 2]]); // 'old@x' never appears — nothing was ever logged under it
  const roster = [{ personKey: 'new@x', displayName: 'X' }];
  const merged = await ScrumEngine.prototype._mergeLinkedIdentityHours.call(self, roster, hours);
  assert.strictEqual(merged.get('new@x'), 2, 'unchanged — nothing to merge in');
});

module.exports = run;
